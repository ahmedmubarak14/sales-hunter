/* ============================================================
   Sales Hunter — application
   Hash router + view renderers. State lives in localStorage
   (persona, theme, profile edits, leads submitted in the demo).
   ============================================================ */

(function () {
  'use strict';

  var app = document.getElementById('app');

  /* ---------------- State ---------------- */
  var LS = {
    get: function (k, fallback) {
      try { var v = localStorage.getItem('sh.' + k); return v === null ? fallback : JSON.parse(v); }
      catch (e) { return fallback; }
    },
    set: function (k, v) { try { localStorage.setItem('sh.' + k, JSON.stringify(v)); } catch (e) {} }
  };

  /* ---- Users & roles: hunter (emp) / management (mgr) / finance (fin).
     Base users come from data.js; Management can add users and change
     roles — stored as overrides + custom records. ---- */
  function roleName(r) { return t(r === 'emp' ? 'roleHunter' : r === 'mgr' ? 'roleMgmt' : 'roleFin'); }
  function baseUsers() {
    return EMPLOYEES.map(function (e) { return Object.assign({ role: 'emp' }, e); })
      .concat([Object.assign({ role: 'mgr' }, MANAGER), Object.assign({ role: 'fin' }, FINANCE)]);
  }
  function usersAll() {
    if (window.LIVE) return LIVE.users.slice();
    var custom = LS.get('users', []);
    var over = LS.get('userOverrides', {});
    return baseUsers().concat(custom).map(function (u) {
      return Object.assign({ active: true }, u, over[u.id] || {});
    });
  }
  // The person actually signed in — never the impersonated one.
  function realUser() {
    if (window.LIVE) return LIVE.me;
    var id = LS.get('user', null);
    if (!id) return null;
    var u = usersAll().find(function (x) { return x.id === id; });
    return u && u.active ? u : null;
  }

  /* "View as" — management can render the app exactly as a given hunter
     sees it, for support and for checking what a hunter is actually shown.
     This is a presentation-layer simulation: the underlying data was still
     fetched under management's own database access, so it will NOT catch a
     row-level-security mistake that hides data from the real hunter. It is
     strictly read-only (see readOnlyView) so management can never write
     anything under someone else's name. */
  function readOnlyNotice(msg) {
    return '<section class="card"><div class="empty">' + esc(msg) + '</div></section>';
  }
  function viewAsId() { return LS.get('viewAs', null); }
  function canImpersonate(u) {
    return !!u && accessesOf(u).indexOf('mgr') >= 0;
  }
  function viewAsUser() {
    var id = viewAsId();
    if (!id) return null;
    if (!canImpersonate(realUser())) { LS.set('viewAs', null); return null; }
    var u = usersAll().find(function (x) { return x.id === id; });
    if (!u) { LS.set('viewAs', null); return null; }
    return u;
  }
  function isViewingAs() { return !!viewAsUser(); }
  // Every mutating control checks this, so an impersonated session can
  // look but never touch.
  function readOnlyView() { return isViewingAs(); }
  function startViewAs(id) {
    if (!canImpersonate(realUser())) return;
    LS.set('viewAs', id);
    location.hash = '#' + homeOf('emp');
    route();
  }
  function stopViewAs() {
    LS.set('viewAs', null);
    location.hash = '#' + homeOf(roleOf());
    route();
  }

  function currentUser() {
    return viewAsUser() || realUser();
  }
  /* A user with a secondary access (e.g. finance who also hunts) can
     switch which one is active; the choice sticks until sign-out. */
  /* A user can hold any combination of the three accesses. `role` is the
     primary — it decides the landing view — and the rest ride alongside.
     Demo users predate this and only carry `role`. */
  function accessesOf(u) {
    if (!u) return [];
    var list = (u.accesses && u.accesses.length ? u.accesses.slice() : [u.role]);
    // primary always first, duplicates dropped
    return [u.role].concat(list).filter(function (r, i, all) {
      return r && all.indexOf(r) === i;
    });
  }
  function extraAccessesOf(u) {
    return accessesOf(u).filter(function (r) { return r !== (u && u.role); });
  }

  function roleOf() {
    var u = currentUser();
    if (!u) return 'emp';
    // activeRole belongs to the signed-in user, not the one being viewed —
    // while impersonating, always render that person's own primary role.
    if (isViewingAs()) return u.role;
    var act = LS.get('activeRole', null);
    if (act && accessesOf(u).indexOf(act) >= 0) return act;
    return u.role;
  }
  function isManager() { return roleOf() === 'mgr'; }
  function homeOf(role) { return role === 'mgr' ? '/manager' : role === 'fin' ? '/payouts' : '/dashboard'; }

  /* Dynamic program settings (Management can change these) */
  var settings = LS.get('settings', {});
  if (settings.commissionRate) COMMISSION_RATE = settings.commissionRate;
  if (settings.vatRate) VAT_RATE = settings.vatRate;
  function ratePct() { return Math.round(COMMISSION_RATE * 100) + '%'; }

  // Every free-text field in a CSV export (deal id, company, hunter name,
  // department, sales rep, bank) is either HubSpot data or something a
  // program participant typed into a form — treat all of it as hostile.
  // Excel/Sheets/LibreOffice execute a cell that starts with = + - @ (or
  // a raw tab/CR) as a formula the moment the file is opened; a company
  // named "=HYPERLINK(...)" or "=cmd|..." runs. A leading apostrophe
  // forces the cell to plain text without changing what's shown. Every
  // field is always quoted and its own quotes doubled — one call site
  // (salesOwner) previously wrapped in quotes without escaping embedded
  // ones at all, which could break the row's column alignment outright.
  function csvCell(v) {
    var s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  // Shared label for a commissionStatus() value, used everywhere a status
  // chip or <select> option is rendered. 'awaiting' is a live-mode-only
  // state — a won deal Metabase hasn't calculated a commission for yet —
  // kept distinct from 'pending' so it never reads as something finance
  // can act on (nothing exists yet to approve or pay).
  function statusLabel(cs) {
    return cs === 'paid' ? t('paid') : cs === 'approved' ? t('approved')
      : cs === 'awaiting' ? t('awaitingCalc') : t('pendingApproval');
  }
  function vatPct() { return Math.round(VAT_RATE * 100) + '%'; }

  /* Audit log for sensitive actions (backoffice) */
  function audit(action) {
    var log = LS.get('audit', []);
    log.unshift({ at: new Date().toISOString(), who: (currentUser() || {}).name || 'Unknown', action: action });
    LS.set('audit', log.slice(0, 50));
  }

  /* Payslips uploaded by finance, keyed by deal id (demo: stored locally) */
  function getSlips() { return LS.get('payslips', {}); }
  function saveSlip(dealId, slip) {
    var slips = getSlips();
    slips[dealId] = slip;
    try { localStorage.setItem('sh.payslips', JSON.stringify(slips)); return true; }
    catch (e) { return false; } // storage quota exceeded
  }
  function hasSlip(dealId) {
    return window.LIVE ? SH_API.hasPayslip(dealId) : !!getSlips()[dealId];
  }
  function slipLink(dealId, cls) {
    if (window.LIVE) {
      if (!SH_API.hasPayslip(dealId)) return '';
      return '<button class="linklike slip-open ' + (cls || '') + '" data-deal="' + esc(dealId) + '">' + t('payslipDl') + '</button>';
    }
    var slip = getSlips()[dealId];
    if (!slip) return '';
    return '<a class="' + (cls || '') + '" href="' + slip.dataUrl + '" download="' + esc(slip.name) + '">' + t('payslipDl') + '</a>';
  }

  /* Payout details: saved profile overrides the employee defaults */
  function payoutDetailsOf(emp) {
    if (window.LIVE) {
      var pr = SH_API.profileOf(emp) || {};
      var full = (LIVE.ibanByUser || {})[emp.dbId];
      return { bank: pr.bank || '—', iban: full || (pr.iban_last4 ? ('SA000000000000000000' + pr.iban_last4) : '') };
    }
    var saved = LS.get('profile.' + emp.id, {});
    return { bank: saved.bank || emp.bank, iban: saved.iban || emp.iban };
  }
  function maskIban(iban) { return iban ? 'SA·· ···· ' + iban.slice(-4) : '—'; }

  /* Leads submitted through the demo form (persisted locally) */
  function customLeads() {
    if (window.LIVE) return [];
    return LS.get('leads', []).map(function (l) {
      return Object.assign({}, l, {
        createdAt: new Date(l.createdAt),
        events: l.events.map(function (e) { return { stage: e.stage, date: new Date(e.date) }; })
      });
    });
  }
  function allLeads() { return customLeads().concat(LEADS); }
  function leadsOf(empId) { return allLeads().filter(function (l) { return l.hunterId === empId; }); }
  function commThisMonthOf(leads) {
    var mk = monthKey(NOW);
    return leads.reduce(function (a, l) {
      var wd = l.stage === 'won' ? wonDate(l) : null;
      return a + (wd && monthKey(wd) === mk ? commissionOf(l) : 0);
    }, 0);
  }

  /* ---------------- Theme ---------------- */
  function applyTheme() {
    // Default to light for everyone; dark is opt-in via the toggle.
    var t = LS.get('theme', null) || 'light';
    document.documentElement.setAttribute('data-theme', t);
  }
  function toggleTheme() {
    var cur = LS.get('theme', null) || 'light';
    LS.set('theme', cur === 'dark' ? 'light' : 'dark');
    applyTheme();
  }

  /* ---------------- Small helpers ---------------- */
  function el(html) {
    var t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }
  function initials(name) {
    return name.split(' ').filter(Boolean).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase();
  }
  /* Avatar = Google photo if synced, else initials. The photo overlays
     the initials and reveals them again if the image fails to load. */
  function avatarHtml(u, cls, style) {
    var ini = esc(initials(u.name || '?'));
    var s = style ? ' style="' + style + '"' : '';
    var inner = u && u.avatar
      ? ini + '<img class="av-img" src="' + esc(u.avatar) + '" alt="" referrerpolicy="no-referrer" onerror="this.remove()">'
      : ini;
    return '<span class="avatar' + (cls ? ' ' + cls : '') + '"' + s + '>' + inner + '</span>';
  }
  function toast(msg) {
    // surface-level failures are logged so management can see breakage
    if (/HTTP \d|failed|error|denied/i.test(String(msg)) && window.SH_API && SH_API.logError) {
      SH_API.logError(String(msg), 'toast');
    }
    var t = el('<div class="toast" role="status">' + esc(msg) + '</div>');
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3200);
  }
  function stagePill(stageId) {
    var st = STAGE_BY_ID[stageId];
    var g = st.group === 'open' ? 'g-open' : st.group === 'won' ? 'g-won' : st.group === 'lost' ? 'g-lost' : 'g-unq';
    return '<span class="stage-pill ' + g + '"><i></i>' + esc(trStage(st.label)) + '</span>';
  }
  function deltaHTML(cur, prev, label) {
    if (prev === 0 && cur === 0) return '<span>' + esc(label) + '</span>';
    var cls = cur >= prev ? 'up' : 'down';
    var sign = cur >= prev ? '+' : '−';
    var diff = Math.abs(cur - prev);
    return '<span class="' + cls + '">' + sign + fmtNum(diff) + '</span> ' + esc(label);
  }

  var ICONS = {
    pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;vertical-align:-2px"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    chevronLeft: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M15 18l-6-6 6-6"/></svg>',
    chevronDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 9l6 6 6-6"/></svg>',
    tick: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 12.5l4.5 4.5L19 7"/></svg>',
    ban: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>',
    camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2.2l1.1-1.8A1 1 0 0 1 8.7 4.7h6.6a1 1 0 0 1 .9.5L17.3 7h2.2A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-9Z"/><circle cx="12" cy="12.8" r="3.3"/></svg>',
    menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 12a8 8 0 1 1-2.5-5.8"/><path d="M20 4v4.5h-4.5"/></svg>',
    plug: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0V8ZM12 20v2"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/></svg>',
    dash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
    leads: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="3.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="3.5" cy="18" r="1.4" fill="currentColor" stroke="none"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
    money: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 10v.01M18 14v.01"/></svg>',
    trophy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 4h8v5a4 4 0 0 1-8 0V4Z"/><path d="M8 5H5a3 3 0 0 0 3 5M16 5h3a3 3 0 0 1-3 5M12 13v4m-4 4h8m-6.5-4h5"/></svg>',
    person: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-3.6 4.5-5 8-5s6.5 1.4 8 5"/></svg>',
    manager: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20V10m5.5 10V4m5.5 16v-8m5 8V7"/></svg>',
    store: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 10 5.5 4h13L20 10M4 10v9a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-9M4 10h16M9.5 20v-6h5v6"/></svg>',
    team: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c1.2-3 3.7-4.5 6.5-4.5s5.3 1.5 6.5 4.5M16 4.8a3.5 3.5 0 0 1 0 6.4M17.5 15.7c2 .6 3.4 1.9 4 4.3"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/></svg>',
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3M15 8l4 4-4 4M19 12H9"/></svg>'
  };

  /* Zid wordmark (زد + spark), from brand.zid.sa — inherits currentColor */
  var LOGO = '<svg class="zid-logo" viewBox="0 0 455 216" fill="none" role="img" aria-label="Zid">' +
    '<path d="M76.66 168.21H0V137.46H66.62C73.45 137.46 75.59 135.75 75.59 128.71V114.62C75.59 89 68.54 81.1 42.92 81.1H21.57V50.35H42.92C89.9 50.35 105.48 67.65 105.48 114.62V139.18C105.48 156.26 93.74 168.22 76.65 168.22L76.66 168.21Z" fill="currentColor"/>' +
    '<path d="M171.188 77.03V146.64C171.188 180.81 145.568 209.63 111.398 209.63V178.03C128.478 178.03 141.288 163.72 141.288 146.64V77.03H171.178H171.188ZM156.028 67.63C165.208 67.63 173.108 60.16 173.108 50.55C173.108 40.94 165.208 33.47 156.028 33.47C146.848 33.47 138.948 41.37 138.948 50.55C138.948 59.73 146.418 67.63 156.028 67.63Z" fill="currentColor"/>' +
    '<path fill-rule="evenodd" clip-rule="evenodd" d="M346.72 19.31C341.17 19.31 336.71 23.77 336.71 29.32C336.71 40.57 340.26 51.47 346.72 60.51C353.18 51.47 356.73 40.56 356.73 29.32C356.73 23.77 352.27 19.31 346.72 19.31ZM360.06 74.88C370.35 62.01 376.04 45.95 376.04 29.32C376.04 12.69 362.93 0 346.72 0C330.51 0 317.4 13.11 317.4 29.32C317.4 45.53 323.1 62.02 333.38 74.88L313.63 94.63C300.76 84.34 284.7 78.65 268.07 78.65C251.44 78.65 238.75 91.76 238.75 107.97C238.75 124.18 251.86 137.29 268.07 137.29C284.28 137.29 300.77 131.59 313.63 121.31L333.38 141.06C323.09 153.93 317.4 169.99 317.4 186.62C317.4 203.25 330.51 215.94 346.72 215.94C362.93 215.94 376.04 202.83 376.04 186.62C376.04 170.41 370.34 153.92 360.06 141.06L379.81 121.31C392.68 131.6 408.74 137.29 425.37 137.29C442 137.29 454.69 124.18 454.69 107.97C454.69 91.76 441.58 78.65 425.37 78.65C409.16 78.65 392.67 84.35 379.81 94.63L360.06 74.88ZM346.72 88.86L327.6 107.98L346.72 127.1L365.84 107.98L346.72 88.86ZM394.18 107.97C403.22 114.43 414.13 117.98 425.37 117.98C430.92 117.98 435.38 113.52 435.38 107.97C435.38 102.42 430.92 97.96 425.37 97.96C414.12 97.96 403.22 101.51 394.18 107.97ZM346.72 155.43C340.26 164.47 336.71 175.38 336.71 186.62C336.71 192.17 341.17 196.63 346.72 196.63C352.27 196.63 356.73 192.17 356.73 186.62C356.73 175.37 353.18 164.47 346.72 155.43ZM299.26 107.97C290.22 101.51 279.31 97.96 268.07 97.96C262.52 97.96 258.06 102.42 258.06 107.97C258.06 113.52 262.52 117.98 268.07 117.98C279.32 117.98 290.22 114.43 299.26 107.97Z" fill="currentColor"/></svg>';

  /* Sales Hunter's own mark: a target crosshair in Zid purple */
  var SH_MARK = '<svg class="sh-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true">' +
    '<circle cx="16" cy="16" r="12.5" stroke="currentColor" stroke-width="2.6"/>' +
    '<circle cx="16" cy="16" r="6" stroke="currentColor" stroke-width="2.6"/>' +
    '<circle cx="16" cy="16" r="1.9" fill="currentColor"/>' +
    '<path d="M16 .8v6M16 25.2v6M.8 16h6M25.2 16h6" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>';

  var GOOGLE_G = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">' +
    '<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>' +
    '<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>' +
    '<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>' +
    '<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';

  var HERO_RINGS = '<svg class="hero-rings" viewBox="0 0 580 580" fill="none" aria-hidden="true">' +
    [250, 205, 160, 115, 70].map(function (r, i) {
      return '<circle cx="290" cy="290" r="' + r + '" stroke="rgba(174,114,255,' + (0.16 + i * 0.1) + ')" stroke-width="2"/>';
    }).join('') +
    '<circle cx="290" cy="290" r="26" fill="#ae72ff"/>' +
    '<path d="M290 20v70M290 490v70M20 290h70M490 290h70" stroke="rgba(174,114,255,0.55)" stroke-width="2.5" stroke-linecap="round"/></svg>';

  /* Hunter ranks (gamification) */
  var RANKS = [
    { name: 'Rookie Hunter', minWins: 0 },
    { name: 'Active Hunter', minWins: 1 },
    { name: 'Pro Hunter', minWins: 5 },
    { name: 'Elite Hunter', minWins: 12 }
  ];
  function rankFor(wins) {
    var cur = RANKS[0], next = null;
    for (var i = 0; i < RANKS.length; i++) {
      if (wins >= RANKS[i].minWins) cur = RANKS[i];
      else { next = RANKS[i]; break; }
    }
    var progress = 1;
    if (next) {
      var span = next.minWins - cur.minWins;
      progress = span > 0 ? (wins - cur.minWins) / span : 0;
    }
    return { current: cur, next: next, progress: Math.max(0, Math.min(1, progress)) };
  }
  function hunterCode(emp) {
    if (emp.code) return emp.code;
    var idx = EMPLOYEES.findIndex(function (e) { return e.id === emp.id; });
    return String(8681849160 + (idx < 0 ? 99 : idx));
  }

  /* ---------------- Router ---------------- */
  var ROUTES = {
    '/dashboard':  { titleKey: 'navDashboard',   icon: 'dash',    render: viewDashboard, who: 'emp', section: 'main' },
    '/leads':      { titleKey: 'navLeads',        icon: 'leads',   render: viewLeads,     who: 'emp', section: 'work' },
    '/submit':     { titleKey: 'navSubmit',       icon: 'plus',    render: viewSubmit,    who: 'emp', section: 'work' },
    '/commission': { titleKey: 'navCommission',   icon: 'money',   render: viewCommission,who: 'emp', section: 'work' },
    '/stores':     { titleKey: 'navStores',       icon: 'store',   render: viewTopStores, who: 'all', section: 'insights' },
    '/manager':    { titleKey: 'navOverview',     icon: 'manager', render: viewManager,   who: 'mgr', section: 'main' },
    '/performance':{ titleKey: 'navPerformance',  icon: 'trophy',  render: viewPerformance, who: 'mgr', section: 'work' },
    '/team':       { titleKey: 'navTeam',         icon: 'team',    render: viewTeam,      who: 'mgr', section: 'work' },
    '/payouts':    { titleKey: 'navPayouts',      icon: 'money',   render: viewPayouts,   who: 'fin', section: 'main' },
    '/hunters':    { titleKey: 'navHunters',      icon: 'person',  render: viewHunters,   who: 'fin', section: 'work' },
    '/integrations':{ titleKey: 'navIntegrations', icon: 'plug',   render: viewIntegrations, who: 'mgr', section: 'account' },
    '/settings':   { titleKey: 'navSettings',     icon: 'gear',    render: viewSettings,  who: 'mgr', section: 'account' },
    '/profile':    { titleKey: 'navProfile',      icon: 'person',  render: viewProfile,   who: 'emp', section: 'account' }
  };
  // Sidebar section order + headers (null header = no label, just a divider)
  var NAV_SECTIONS = [
    { key: 'main', label: null },
    { key: 'work', label: 'navSecWork' },
    { key: 'insights', label: 'navSecInsights' },
    { key: 'account', label: 'navSecAccount' }
  ];
  // Small live badges next to certain items
  function navBadge(p) {
    try {
      if (p === '/leads') { var n = statsFor(leadsOf(currentUser().id)).open; return n > 0 ? n : 0; }
      if (p === '/payouts') { var s = statsFor(allLeads()); return (s.commissionPending > 0) ? allLeads().filter(function (l) { return l.stage === 'won' && commissionStatus(l) === 'pending'; }).length : 0; }
    } catch (e) {}
    return 0;
  }

  // Finance sees ONLY its own views. Management additionally gets the
  // finance views (read-only there — approvals stay a finance action).
  function canAccess(who, role) {
    if (role === 'fin') return who === 'fin';
    if (role === 'mgr') return who === 'mgr' || who === 'all' || who === 'fin';
    return who === 'all' || who === role;
  }

  function route() {
    // A re-render replaces the view wholesale, so whatever the user had
    // typed is gone by definition — the dirty flag that protects forms
    // from auto-refresh resets here rather than lingering forever.
    clearDirty();
    var h = location.hash.replace(/^#/, '') || '/';
    if (!currentUser()) { renderLogin(); return; }
    /* users holding two accesses pick which one to enter with, once per sign-in */
    var cu = currentUser();
    // The access chooser is about the signed-in user's own two accesses —
    // it must not appear when standing in for someone else.
    if (!isViewingAs() && accessesOf(cu).length > 1 && !LS.get('activeRole', null)) { renderAccessChooser(cu); return; }
    var home = homeOf(roleOf());
    if (!ROUTES[h]) { location.hash = '#' + home; return; }
    var r = ROUTES[h];
    if (!canAccess(r.who, roleOf())) { location.hash = '#' + home; return; }
    renderShell(h, r);
  }

  /* ---------------- Login ---------------- */
  function renderLogin() {
    var users = usersAll().filter(function (u) { return u.active; });
    // Exactly three accesses: Hunter, Management, Finance
    var ACCESS = [
      { id: 'e1',  icon: 'dash',    desc: t('accessHunter') },
      { id: 'mgr', icon: 'manager', desc: t('accessMgmt') },
      { id: 'fin', icon: 'money',   desc: t('accessFin') }
    ];
    var personas = ACCESS.map(function (a) {
      var u = users.find(function (x) { return x.id === a.id; });
      if (!u) return '';
      var dark = u.role !== 'emp' ? ' style="background: var(--ink); color: var(--ground)"' : '';
      return '<button class="persona" data-login="' + esc(u.id) + '">' +
        '<span class="avatar"' + dark + '>' + ICONS[a.icon] + '</span>' +
        '<span class="who"><b>' + esc(roleName(u.role)) + '</b><span>' + esc(a.desc) + '</span>' +
        '<span class="p-as">' + t('loginAs', { name: esc(u.name), title: esc(u.title || '') }) + '</span></span>' +
        '<span class="go">→</span></button>';
    }).join('');
    // users added through Team & Access sign in here too
    var custom = users.filter(function (u) { return String(u.id).charAt(0) === 'u'; });
    if (custom.length) {
      personas += '<p class="eyebrow" style="margin:10px 2px 2px">' + t('addedByMgmt') + '</p>' +
        custom.map(function (u) {
          return '<button class="persona" data-login="' + esc(u.id) + '">' +
            '<span class="avatar">' + esc(initials(u.name)) + '</span>' +
            '<span class="who"><b>' + esc(u.name) + '</b><span>' + esc(u.title || '') + ' · ' + esc(roleName(u.role)) + '</span></span>' +
            '<span class="go">→</span></button>';
        }).join('');
    }

    var live = !!(window.SH_API && SH_API.enabled());
    var liveCard = '';
    if (live) {
      liveCard =
        '<div class="card" style="margin-bottom:14px">' +
          '<h2>' + t('liveTitle') + '</h2><p class="sub">' + t('liveSub') + '</p>' +
          (window.LIVE_ERROR === 'no_app_user' ? '<p class="f-error" style="margin-top:8px">' + t('noAppUser') + '</p>' : '') +
          (window.LIVE_AUTH_ERROR ? '<p class="f-error" style="margin-top:8px">' +
            (window.LIVE_AUTH_ERROR === 'otp_expired' ? t('linkExpired') : t('authError')) + '</p>' : '') +
          '<button class="btn" id="live-google" style="width:100%; margin-top:12px; display:flex; align-items:center; justify-content:center; gap:8px">' +
            GOOGLE_G + t('googleBtn') + '</button>' +
          '<p class="eyebrow" style="margin:12px 2px 0">' + t('orEmail') + '</p>' +
          '<div style="display:flex; gap:8px; margin-top:8px"><input type="email" id="live-email" placeholder="you@zid.sa" style="flex:1">' +
          '<button class="btn" id="live-send">' + t('sendLink') + '</button></div>' +
          '<div id="live-step2"' + (window.LIVE_AUTH_ERROR === 'otp_expired' ? '' : ' hidden') + ' style="margin-top:10px"><p class="f-hint">' + t('linkSent') + '</p>' +
          '<div style="display:flex; gap:8px; margin-top:6px"><input type="text" id="live-code" placeholder="' + t('codePh') + '" style="flex:1" inputmode="numeric">' +
          '<button class="btn secondary" id="live-verify">' + t('verifyBtn') + '</button></div></div>' +
        '</div>';
    }
    /* On a live deployment the mock personas disappear — demo data is
       only browsable at ?mode=mock. */
    var demoCard = live ? '' :
      '<div class="card">' +
        '<h2>' + t('signIn') + '</h2>' +
        '<p class="sub">' + t('signInSub') + '</p>' +
        '<div class="persona-list">' + personas + '</div>' +
      '</div>';
    var ps = statsFor(allLeads()); // program-wide, for the hero stats (demo only)
    var heroStats = live ? '' :
      '<div class="hero-stats">' +
        '<div class="hero-stat"><b>' + fmtMoneyC(ps.commission) + '</b><span>' + t('heroEarned') + '</span></div>' +
        '<div class="hero-stat"><b>' + fmtNum(ps.won) + '</b><span>' + t('heroMerchants') + '</span></div>' +
        '<div class="hero-stat"><b>' + fmtPct(ps.conversion, 0) + '</b><span>' + t('heroClose') + '</span></div>' +
      '</div>';
    app.innerHTML =
      '<div class="login-wrap">' +
        '<div class="login-left"><div class="login-card">' +
          '<div class="brand">' + SH_MARK + '<div><b>' + t('appName') + '</b><small>' + t('tagline') + '</small></div></div>' +
          liveCard +
          demoCard +
          '<p class="login-note">' + (live ? '' : t('loginNote') + ' · ') + '<a href="#" id="login-lang">' + t('langToggle') + '</a></p>' +
        '</div></div>' +
        '<div class="login-hero">' +
          HERO_RINGS +
          '<h2>' + t('heroTitle', { rate: ratePct() }) + '</h2>' +
          '<p>' + t('heroSub') + '</p>' +
          heroStats +
          '<div class="hero-zid">' + t('heroBy') + ' ' + LOGO + '</div>' +
        '</div>' +
      '</div>';

    if (window.SH_API && SH_API.enabled()) {
      document.getElementById('live-google').addEventListener('click', function () {
        SH_API.signInWithGoogle();
      });
      document.getElementById('live-send').addEventListener('click', function () {
        var em = document.getElementById('live-email').value.trim();
        if (!em) return;
        var btn = this; btn.disabled = true;
        SH_API.sendMagicLink(em).then(function () {
          document.getElementById('live-step2').hidden = false;
          btn.disabled = false;
        }).catch(function (e2) { toast(String(e2.message)); btn.disabled = false; });
      });
      document.getElementById('live-verify').addEventListener('click', function () {
        var em = document.getElementById('live-email').value.trim();
        var code = document.getElementById('live-code').value.trim();
        if (!em || !code) return;
        toast(t('loadingLive'));
        SH_API.verifyOtp(em, code).then(function () {
          return SH_API.init();
        }).then(function (ok) {
          if (ok) { location.hash = '#' + homeOf(roleOf()); route(); }
          else renderLogin();
        }).catch(function (e2) { toast(String(e2.message)); });
      });
    }
    document.getElementById('login-lang').addEventListener('click', function (e) {
      e.preventDefault();
      setLang(isAr() ? 'en' : 'ar');
      renderLogin();
    });
    app.querySelectorAll('[data-login]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        LS.set('user', btn.getAttribute('data-login'));
        location.hash = '#' + homeOf(roleOf());
        route();
      });
    });
  }

  /* ------- Hunter onboarding: locked screen until profile complete ------- */
  function bankSelect(id, selected) {
    var known = selected && BANKS.indexOf(selected) >= 0;
    var custom = selected && !known;
    return '<select id="' + id + '" required>' +
      '<option value="" disabled' + (selected ? '' : ' selected') + '>' + t('chooseBank') + '</option>' +
      BANKS.map(function (b) {
        var sel = (known && b === selected) || (custom && b === 'Other');
        return '<option value="' + esc(b) + '"' + (sel ? ' selected' : '') + '>' + esc(trBank(b)) + '</option>';
      }).join('') + '</select>' +
      '<input id="' + id + '-other" type="text"' + (custom ? ' value="' + esc(selected) + '"' : ' hidden') +
        ' placeholder="' + t('bankOtherPh') + '" style="margin-top:8px">';
  }
  function wireBankOther(id) {
    var sel = document.getElementById(id), other = document.getElementById(id + '-other');
    sel.addEventListener('change', function () {
      other.hidden = sel.value !== 'Other';
      other.required = sel.value === 'Other';
    });
  }
  function bankValue(id) {
    var sel = document.getElementById(id), other = document.getElementById(id + '-other');
    return sel.value === 'Other' ? other.value.trim() : sel.value;
  }

  /* Reusable drag-and-drop file field. Wraps a real <input type=file>
     (kept by id so existing validation still works) with a dropzone
     and a selected-file card. */
  var DZ_CLOUD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" style="width:22px;height:22px"><path d="M12 15V4m0 0-3.5 3.5M12 4l3.5 3.5"/><path d="M4 15v2.5A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5V15"/></svg>';
  var DZ_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width:15px;height:15px"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0v12a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V7"/></svg>';
  function fileDrop(id, accept, hint) {
    return '<div class="dropzone" id="' + id + '-zone" tabindex="0" role="button" aria-label="' + t('dzClick') + '">' +
        '<input type="file" id="' + id + '" accept="' + accept + '" hidden>' +
        '<span class="dz-cloud">' + DZ_CLOUD + '</span>' +
        '<p class="dz-text"><span class="dz-link">' + t('dzClick') + '</span> ' + t('dzOrDrag') + '</p>' +
        '<p class="dz-hint">' + esc(hint) + '</p>' +
      '</div>' +
      '<div class="dz-file" id="' + id + '-card" hidden>' +
        '<span class="dz-badge" id="' + id + '-badge"></span>' +
        '<div class="dz-meta"><b class="dz-name" id="' + id + '-name"></b><span class="dz-size" id="' + id + '-size"></span></div>' +
        '<button type="button" class="dz-remove" id="' + id + '-remove" aria-label="' + t('remove') + '">' + DZ_TRASH + '</button>' +
      '</div>';
  }
  function wireFileDrop(id) {
    var input = document.getElementById(id);
    var zone = document.getElementById(id + '-zone');
    var card = document.getElementById(id + '-card');
    if (!input || !zone) return;
    function fmtSize(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }
    function show() {
      var f = input.files[0];
      if (!f) { card.hidden = true; zone.hidden = false; return; }
      var ext = (f.name.split('.').pop() || '').toUpperCase().slice(0, 4);
      document.getElementById(id + '-badge').textContent = ext || 'FILE';
      document.getElementById(id + '-name').textContent = f.name;
      document.getElementById(id + '-size').textContent = fmtSize(f.size);
      card.hidden = false; zone.hidden = true;
    }
    zone.addEventListener('click', function () { input.click(); });
    zone.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    input.addEventListener('change', show);
    ['dragenter', 'dragover'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove('drag'); });
    });
    zone.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files.length) { input.files = e.dataTransfer.files; show(); }
    });
    document.getElementById(id + '-remove').addEventListener('click', function () { input.value = ''; show(); });
  }

  /* IBAN section on the profile page: the saved IBAN shows read-only
     with an Edit toggle; editing reveals the input + a required
     certificate upload. Any existing certificate is viewable. */
  function ibanBlock(p, certPath) {
    var hasIban = !!p.iban;
    return '<div>' +
      '<label class="f-label" for="p-iban">' + t('ibanLbl') + '</label>' +
      (hasIban
        ? '<div id="iban-view" style="display:flex; gap:8px; align-items:center">' +
            '<input type="text" value="' + esc(fmtIbanFull(p.iban)) + '" readonly ' +
              'style="flex:1; opacity:.75; font-variant-numeric:tabular-nums">' +
            '<button type="button" class="ghost-btn" id="iban-edit" style="flex:none">' + ICONS.pencil + ' ' + t('editBtn') + '</button>' +
          '</div>'
        : '') +
      '<div id="iban-edit-wrap"' + (hasIban ? ' hidden' : '') + (hasIban ? ' style="margin-top:8px"' : '') + '>' +
        '<input type="text" id="p-iban" placeholder="SA00 0000 0000 0000 0000 0000" autocomplete="off">' +
        '<p class="f-error" id="p-iban-err" hidden></p>' +
        (window.LIVE
          ? '<label class="f-label" style="margin-top:10px">' + t('ibanCertLbl') + '</label>' +
            fileDrop('p-cert', '.pdf,.png,.jpg,.jpeg,image/*,application/pdf', t('ibanCertRequired'))
          : '') +
      '</div>' +
      (window.LIVE && certPath
        ? '<p class="f-hint" style="margin-top:8px">' + t('ibanCertOnFile') +
          ' <button type="button" class="linklike" id="iban-cert-view">' + t('viewDownload') + '</button></p>'
        : (window.LIVE && hasIban ? '<p class="f-hint" style="margin-top:8px">' + t('ibanCertMissing') + '</p>' : '')) +
    '</div>';
  }

  /* Two accesses → pick one at sign-in. The topbar switcher still
     allows flipping later. */
  function renderAccessChooser(user) {
    var DESC = { emp: 'accessHunter', mgr: 'accessMgmt', fin: 'accessFin' };
    var ICON = { emp: 'dash', mgr: 'manager', fin: 'money' };
    var cards = accessesOf(user).map(function (rr) {
      var dark = rr !== 'emp' ? ' style="background: var(--ink); color: var(--ground)"' : '';
      return '<button class="persona" data-access="' + rr + '">' +
        '<span class="avatar"' + dark + '>' + ICONS[ICON[rr]] + '</span>' +
        '<span class="who"><b>' + esc(roleName(rr)) + '</b><span>' + t(DESC[rr]) + '</span></span>' +
        '<span class="go">→</span></button>';
    }).join('');
    app.innerHTML =
      '<div class="login-wrap">' +
        '<div class="login-left"><div class="login-card">' +
          '<div class="brand">' + SH_MARK + '<div><b>' + t('appName') + '</b><small>' + t('tagline') + '</small></div></div>' +
          '<div class="card">' +
            '<h2>' + t('chooseAccessTitle', { name: esc(user.name.split(' ')[0]) }) + '</h2>' +
            '<p class="sub">' + t('chooseAccessSub') + '</p>' +
            '<div class="persona-list" style="margin-top:12px">' + cards + '</div>' +
          '</div>' +
          '<p class="login-note"><a href="#" id="chooser-signout">' + t('signOut') + '</a></p>' +
        '</div></div>' +
        '<div class="login-hero">' +
          HERO_RINGS +
          '<h2>' + t('heroTitle', { rate: ratePct() }) + '</h2><p>' + t('heroSub') + '</p>' +
          '<div class="hero-zid">' + t('heroBy') + ' ' + LOGO + '</div>' +
        '</div>' +
      '</div>';
    app.querySelectorAll('[data-access]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var rr = btn.getAttribute('data-access');
        LS.set('activeRole', rr);
        location.hash = '#' + homeOf(rr);
        route();
      });
    });
    document.getElementById('chooser-signout').addEventListener('click', function (e) {
      e.preventDefault();
      LS.set('activeRole', null);
      if (window.LIVE) { SH_API.signOut(); location.hash = ''; location.reload(); return; }
      LS.set('user', null); location.hash = ''; route();
    });
  }

  /* The onboarding form renders over the live app and cannot be
     dismissed: a hunter must complete it before doing anything. Users
     who also hold staff access can bail out to that access instead. */
  function openOnboardingModal() {
    if (document.getElementById('ob-overlay')) return;
    var user = currentUser();
    /* a staff access they can fall back to instead of onboarding now */
    var otherAccess = accessesOf(user).filter(function (r) { return r !== 'emp'; })[0] || null;
    var root = el('<div id="ob-overlay" class="ob-overlay" role="dialog" aria-modal="true" aria-label="' + t('obTitle') + '">' +
      '<div class="card ob-modal">' +
        '<h2>' + t('obTitle') + '</h2><p class="sub">' + t('obSub') + '</p>' +
        '<form id="ob-form" style="margin-top:14px">' +
          '<div class="form-grid">' +
            '<div><label class="f-label" for="ob-name">' + t('fullName') + '</label>' +
              '<input id="ob-name" type="text" required value="' + esc(user.name || '') + '">' +
              '<p class="f-hint">' + t('obNameHint') + '</p></div>' +
            '<div><label class="f-label" for="ob-dept">' + t('deptStar') + '</label>' +
              '<input id="ob-dept" type="text" required value="' + esc(user.dept && user.dept !== 'General' ? user.dept : '') + '" placeholder="' + t('deptPh') + '"></div>' +
            '<div><label class="f-label" for="ob-phone">' + t('mobileStar') + '</label>' +
              '<input id="ob-phone" type="tel" required placeholder="+966555555928"></div>' +
            '<div><label class="f-label" for="ob-pemail">' + t('personalEmailStar') + '</label>' +
              '<input id="ob-pemail" type="email" required placeholder="personal@gmail.com"></div>' +
            '<div><label class="f-label" for="ob-bank">' + t('bankStar') + '</label>' + bankSelect('ob-bank', null) + '</div>' +
            '<div><label class="f-label" for="ob-iban">' + t('ibanStar') + '</label>' +
              '<input id="ob-iban" type="text" required placeholder="SA00 0000 0000 0000 0000 0000" autocomplete="off">' +
              '<p class="f-error" id="ob-err" hidden></p></div>' +
            '<div><label class="f-label">' + t('ibanCertStar') + '</label>' +
              fileDrop('ob-cert', '.pdf,.png,.jpg,.jpeg,image/*,application/pdf', t('ibanCertHint')) + '</div>' +
          '</div>' +
          '<div style="margin-top:16px; display:flex; gap:12px; align-items:center; flex-wrap:wrap">' +
            '<button type="submit" class="btn">' + t('obSubmit') + '</button>' +
            (otherAccess
              ? '<button type="button" class="link-btn" id="ob-switch">' + t('useOtherAccess', { role: roleName(otherAccess) }) + '</button>'
              : '') +
            '<button type="button" class="link-btn" id="ob-signout">' + t('signOut') + '</button>' +
          '</div>' +
        '</form>' +
      '</div>' +
    '</div>');
    document.body.appendChild(root);
    var obRelease = trapOverlay(root.querySelector('.ob-modal'), function () {}, false);
    var obRemove = root.remove.bind(root);
    root.remove = function () { obRelease(); obRemove(); };

    wireBankOther('ob-bank');
    wireFileDrop('ob-cert');
    var sw = document.getElementById('ob-switch');
    if (sw) sw.addEventListener('click', function () {
      LS.set('activeRole', otherAccess);
      root.remove();
      location.hash = '#' + homeOf(otherAccess);
      route();
    });
    document.getElementById('ob-signout').addEventListener('click', function () {
      LS.set('activeRole', null);
      SH_API.signOut(); location.hash = ''; location.reload();
    });
    document.getElementById('ob-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var err = document.getElementById('ob-err');
      var iban = document.getElementById('ob-iban').value.replace(/\s/g, '').toUpperCase();
      if (!/^SA\d{22}$/.test(iban)) { err.textContent = t('ibanErr'); err.hidden = false; return; }
      var bank = bankValue('ob-bank');
      if (!bank) { err.textContent = t('bankReq'); err.hidden = false; return; }
      var certFile = document.getElementById('ob-cert').files[0];
      if (!certFile) { err.textContent = t('ibanCertNeeded'); err.hidden = false; return; }
      err.hidden = true;
      var btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true;
      SH_API.uploadIbanCert(certFile).then(function (path) {
        return SH_API.saveProfile({
          name: document.getElementById('ob-name').value.trim(),
          dept: document.getElementById('ob-dept').value.trim(),
          phone: document.getElementById('ob-phone').value.trim(),
          personalEmail: document.getElementById('ob-pemail').value.trim(),
          bank: bank,
          iban: iban,
          ibanCertPath: path
        });
      }).then(function () {
        root.remove();
        toast(t('obDone'));
        route();
      }).catch(function (e2) { toast(String(e2.message)); btn.disabled = false; });
    });
  }

  /* ---------------- Shell ---------------- */
  function renderShell(path, r) {
    var user = currentUser();
    /* blocking onboarding applies only when acting as a hunter, live */
    var needsOb = !!(window.LIVE && window.SH_API && roleOf() === 'emp' && SH_API.onboardingNeeded());
    var collapsed = LS.get('navCollapsed', false);
    var accessible = Object.keys(ROUTES).filter(function (p) { return canAccess(ROUTES[p].who, roleOf()); });
    var nav = NAV_SECTIONS.map(function (sec, si) {
      var items = accessible.filter(function (p) { return ROUTES[p].section === sec.key; });
      if (!items.length) return '';
      var links = items.map(function (p) {
        var b = navBadge(p);
        return '<a href="#' + p + '" class="' + (p === path ? 'active' : '') + '" title="' + esc(t(ROUTES[p].titleKey)) + '">' +
          ICONS[ROUTES[p].icon] + '<span class="nav-label">' + esc(t(ROUTES[p].titleKey)) + '</span>' +
          (b ? '<span class="nav-badge">' + b + '</span>' : '') + '</a>';
      }).join('');
      return (si > 0 ? '<div class="nav-divider"></div>' : '') +
        (sec.label ? '<p class="nav-sec">' + t(sec.label) + '</p>' : '') + links;
    }).join('');

    app.innerHTML =
      '<div class="shell' + (collapsed ? ' nav-collapsed' : '') + '">' +
        '<aside class="sidebar">' +
          '<div class="brand">' + SH_MARK + '<div class="brand-txt"><b>' + t('appName') + '</b><small>' + t('byZid') + '</small></div>' +
            '<button class="nav-toggle" id="nav-toggle" aria-label="' + t('collapseNav') + '" title="' + t('collapseNav') + '">' + ICONS.chevronLeft + '</button>' +
            '<button class="mobile-menu-btn" id="mobile-menu" aria-label="' + t('menu') + '" aria-expanded="false">' + ICONS.menu + '</button>' +
          '</div>' +
          '<nav class="nav">' + nav + '</nav>' +
          '<div class="side-foot">' +
            '<div class="userchip">' + avatarHtml(user) + '' +
            '<span class="who"><b>' + esc(user.name) + '</b><span>' + esc(trDept(user.dept)) + '</span></span></div>' +
            '<button class="link-btn" id="logout">' + t('signOut') + '</button>' +
          '</div>' +
        '</aside>' +
        '<div class="main">' +
          (isViewingAs()
            ? '<div class="viewas-bar" role="status">' +
                '<span class="va-txt">' + t('viewingAs', { name: esc(user.name) }) + '</span>' +
                '<span class="va-note">' + t('viewingAsNote') + '</span>' +
                '<button class="va-exit" id="exit-viewas">' + t('exitViewAs') + '</button>' +
              '</div>'
            : '') +
          '<div class="topbar">' +
            '<div class="crumbs"><h1>' + esc(t(r.titleKey)) + '</h1>' + (window.LIVE ? '' : '<span class="demo-pill">' + t('demoPill') + '</span>') + '</div>' +
            '<div class="actions">' +
              (accessesOf(user).length > 1 && !isViewingAs() ? '<div class="role-switch" role="group" aria-label="' + t('switchAccess') + '">' +
                accessesOf(user).map(function (rr) {
                  return '<button class="rs-btn' + (rr === roleOf() ? ' active' : '') + '" data-role="' + rr + '">' + roleName(rr) + '</button>';
                }).join('') + '</div>' : '') +
              (window.LIVE ? '<span class="freshness" id="freshness"></span>' +
                '<button class="icon-btn" id="refresh-btn" title="' + t('refreshData') + '" aria-label="' + t('refreshData') + '">' + ICONS.refresh + '</button>' : '') +
              '<button class="icon-btn lang-btn" id="lang-toggle" aria-label="' + t('langToggle') + '">' + (isAr() ? 'EN' : 'ع') + '</button>' +
              '<button class="icon-btn" id="theme-toggle" title="' + t('themeToggle') + '" aria-label="' + t('themeToggle') + '">' + ICONS.sun + '</button>' +
            '</div>' +
          '</div>' +
          '<div class="content" id="content"></div>' +
          (window.LIVE ? '' : '<footer class="app-foot">' + t('footer') + '</footer>') +
        '</div>' +
      '</div>';

    var exitVa = document.getElementById('exit-viewas');
    if (exitVa) exitVa.addEventListener('click', stopViewAs);

    document.getElementById('logout').addEventListener('click', function () {
      LS.set('viewAs', null);
      LS.set('activeRole', null);
      if (window.LIVE) { SH_API.signOut(); location.hash = ''; location.reload(); return; }
      LS.set('user', null); location.hash = ''; route();
    });
    var rb = document.getElementById('refresh-btn');
    if (rb) rb.addEventListener('click', function () { doRefresh(true); });
    updateFreshness();
    document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
    document.getElementById('lang-toggle').addEventListener('click', function () { setLang(isAr() ? 'en' : 'ar'); route(); });
    var mm = document.getElementById('mobile-menu');
    if (mm) mm.addEventListener('click', function () {
      var shell = app.querySelector('.shell');
      var open = !shell.classList.contains('nav-open');
      shell.classList.toggle('nav-open', open);
      this.setAttribute('aria-expanded', String(open));
    });
    // picking a destination closes the mobile menu
    app.querySelectorAll('.nav a').forEach(function (a) {
      a.addEventListener('click', function () {
        var shell = app.querySelector('.shell');
        if (shell) shell.classList.remove('nav-open');
      });
    });
    document.getElementById('nav-toggle').addEventListener('click', function () {
      var shell = app.querySelector('.shell');
      var now = !shell.classList.contains('nav-collapsed');
      shell.classList.toggle('nav-collapsed', now);
      LS.set('navCollapsed', now);
    });
    app.querySelectorAll('.rs-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var rr = btn.getAttribute('data-role');
        if (rr === roleOf()) return;
        LS.set('activeRole', rr);
        location.hash = '#' + homeOf(rr);
        route();
      });
    });

    var content = document.getElementById('content');
    r.render(content, user);
    initTooltip(content);
    wireCardToggles(content);
    wirePendingToggles(content);
    if (needsOb && !isViewingAs()) openOnboardingModal();
    else {
      var ob = document.getElementById('ob-overlay');
      if (ob) ob.remove();
    }
  }

  /* ================= Views ================= */

  function trFunnel(rows) {
    return rows.map(function (f) { return { stage: trStage(f.stage), count: f.count }; });
  }

  /* Keep keyboard focus inside an overlay while it's open, and route
     Escape to its close action. Returns a teardown function.
     `closable: false` (the blocking onboarding modal) traps Tab but
     ignores Escape. */
  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  function trapOverlay(root, onClose, closable) {
    var prev = document.activeElement;
    function visible(el) { return el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement; }
    function items() { return Array.prototype.filter.call(root.querySelectorAll(FOCUSABLE), visible); }
    function onKey(e) {
      if (e.key === 'Escape' && closable !== false) { e.preventDefault(); onClose(); return; }
      if (e.key !== 'Tab') return;
      var f = items();
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (!root.contains(document.activeElement)) { e.preventDefault(); first.focus(); return; }
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey, true);
    var f0 = items()[0];
    if (f0) f0.focus();
    return function release() {
      document.removeEventListener('keydown', onKey, true);
      if (prev && prev.focus && document.contains(prev)) prev.focus();
    };
  }

  /* First-run / zero-data state. Every hunter starts here, so it should
     read as "new", not "broken". */
  function emptyState(icon, title, body, ctaHash, ctaLabel) {
    return '<section class="card empty-state">' +
      '<span class="es-icon">' + (ICONS[icon] || '') + '</span>' +
      '<h3>' + esc(title) + '</h3>' +
      '<p class="sub">' + esc(body) + '</p>' +
      (ctaHash ? '<a class="btn" href="#' + ctaHash + '">' + esc(ctaLabel) + '</a>' : '') +
    '</section>';
  }

  function tile(label, value, deltaHtml) {
    return '<div class="tile"><div class="t-label">' + esc(label) + '</div>' +
      '<div class="t-value">' + value + '</div>' +
      (deltaHtml ? '<div class="t-delta">' + deltaHtml + '</div>' : '') + '</div>';
  }

  /* ---- Employee dashboard ---- */
  function viewDashboard(content, user) {
    var leads = leadsOf(user.id);
    // brand-new hunter: a welcome + how-it-works beats a wall of zeros
    if (!leads.length) {
      content.innerHTML =
        '<div class="welcome-banner"><div><h2>' + t('welcomeBack', { name: esc(user.name.split(' ')[0]) }) + '</h2>' +
          '<p class="w-date">' + t('firstRunTag') + '</p></div></div>' +
        emptyState('plus', t('firstRunTitle'), t('firstRunBody', { rate: ratePct() }), '/submit', t('navSubmit')) +
        '<section class="card">' +
          '<div class="card-head"><div><h3>' + t('firstRunStepsTitle') + '</h3></div></div>' +
          '<ol class="how-steps">' +
            '<li><b>' + t('firstRunStep1') + '</b><span>' + t('firstRunStep1b') + '</span></li>' +
            '<li><b>' + t('firstRunStep2') + '</b><span>' + t('firstRunStep2b') + '</span></li>' +
            '<li><b>' + t('firstRunStep3', { rate: ratePct() }) + '</b><span>' + t('firstRunStep3b') + '</span></li>' +
          '</ol>' +
        '</section>';
      return;
    }
    var s = statsFor(leads);
    var months = last12Months();

    var thisMonthKey = monthKey(NOW);
    var lastMonthKey = monthKey(new Date(NOW.getFullYear(), NOW.getMonth() - 1, 1));
    var leadsThisMonth = leads.filter(function (l) { return monthKey(l.createdAt) === thisMonthKey; }).length;
    var leadsLastMonth = leads.filter(function (l) { return monthKey(l.createdAt) === lastMonthKey; }).length;

    var byMonth = months.map(function (m) {
      return leads.filter(function (l) { return monthKey(l.createdAt) === m.key; }).length;
    });

    // win rate of decided leads per month; null = nothing decided that month
    var winRate = months.map(function (m) {
      var decided = leads.filter(function (l) {
        var cd = closedDate(l); return cd && monthKey(cd) === m.key;
      });
      if (!decided.length) return null;
      return decided.filter(function (l) { return l.stage === 'won'; }).length / decided.length;
    });

    var reasonsLost = reasonTiles(s.lostReasons, s.lostNoReason);
    var reasonsUnq = reasonTiles(s.unqualReasons, s.unqualNoReason);

    var currentStages = STAGES.filter(function (st) { return st.group === 'open'; }).map(function (st) {
      return { label: st.label, count: s.byStage[st.id] };
    }).filter(function (x) { return x.count > 0; });

    // Rank + personalized tips
    var rank = rankFor(s.won);
    var winsToNext = rank.next ? rank.next.minWins - s.won : 0;

    var tips = [];
    // best category by win rate (needs >= 3 decided leads in that category)
    var byCat = {};
    leads.forEach(function (l) {
      var cd = closedDate(l);
      if (!cd) return;
      if (!byCat[l.industry]) byCat[l.industry] = { decided: 0, won: 0 };
      byCat[l.industry].decided += 1;
      if (l.stage === 'won') byCat[l.industry].won += 1;
    });
    var bestCat = null;
    Object.keys(byCat).forEach(function (c) {
      if (byCat[c].decided >= 3) {
        var wr = byCat[c].won / byCat[c].decided;
        if (!bestCat || wr > bestCat.wr) bestCat = { cat: c, wr: wr };
      }
    });
    if (bestCat && bestCat.wr > 0) tips.push(t('tipBestCat', { cat: trCat(bestCat.cat), pct: fmtPct(bestCat.wr, 0) }));
    var topUnq = Object.keys(s.unqualReasons).sort(function (a, b) { return s.unqualReasons[b] - s.unqualReasons[a]; })[0];
    if (topUnq) tips.push(t('tipUnq', { reason: trReason(topUnq) }));
    tips.push(t('tipNotes'));
    tips.push(t('tipStores'));

    content.innerHTML =
      '<div class="welcome-banner">' +
        '<div><h2>' + t('welcomeBack', { name: esc(user.name.split(' ')[0]) }) + '</h2>' +
        '<p class="w-date">' + NOW.toLocaleDateString(isAr() ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + '</p></div>' +
        '<div class="w-chips">' +
          '<span class="wchip solid">' + esc(trRank(rank.current.name)) + '</span>' +
          (rank.next ? '<span class="wchip">' + t(winsToNext === 1 ? 'winTo' : 'winsTo', { n: winsToNext, rank: esc(trRank(rank.next.name)) }) + '</span>'
                     : '<span class="wchip">' + t('topRank') + '</span>') +
        '</div>' +
      '</div>' +

      '<div class="kpis">' +
        tile(t('totalLeads'), fmtNum(s.total), deltaHTML(leadsThisMonth, leadsLastMonth, t('vsLastMonth'))) +
        tile(t('activePipeline'), fmtNum(s.open), t('potentialValue', { v: esc(fmtMoneyC(s.pipelineValue)) })) +
        tile(t('closedWon'), fmtNum(s.won), s.avgCycleDays ? t('avgCycle', { n: s.avgCycleDays }) : '') +
        tile(t('closedLost'), fmtNum(s.lost), '') +
        tile(t('unqualified'), fmtNum(s.unqualified), '') +
        tile(t('conversionRate'), fmtPct(s.conversion), t('convSub')) +
        tile(t('revenueGenerated'), fmtMoneyC(s.revenueNet), t('revSub')) +
        tile(t('commMonthTile'), '<span class="money-pos">' + fmtMoneyC(commThisMonthOf(leads)) + '</span>', t('wonThisMonthSub')) +
        tile(t('commissionEarned'), '<span class="money-pos">' + fmtMoneyC(s.commission) + '</span>', t('notYetPaid', { v: fmtMoneyC(s.commissionPending + s.commissionApproved) })) +
      '</div>' +

      '<div class="grid-2">' +
        '<section class="card">' +
          '<div class="card-head"><div><h3>' + t('hunterLevel') + '</h3><p class="sub">' + t('levelSub') + '</p></div>' +
          '<span class="rank-pct">' + Math.round(rank.progress * 100) + '%</span></div>' +
          '<div class="rank-row"><b style="font-size:17px">' + esc(trRank(rank.current.name)) + '</b></div>' +
          '<div class="rank-track"><div class="rank-fill" style="width:' + Math.max(4, Math.round(rank.progress * 100)) + '%"></div></div>' +
          '<p class="rank-next">' + (rank.next ? t('nextRank', { rank: esc(trRank(rank.next.name)), n: rank.next.minWins }) : t('topRankNote')) + '</p>' +
          '<div class="rank-needs">' +
            '<div class="rank-need"><b>' + fmtNum(s.won) + '</b>' + t('wonSoFar') + '</div>' +
            (rank.next ? '<div class="rank-need"><b>' + winsToNext + '</b>' + t('moreToLevel') + '</div>' : '') +
            '<div class="rank-need"><b>' + fmtNum(s.open) + '</b>' + t('chancesInPlay') + '</div>' +
          '</div>' +
        '</section>' +
        '<section class="card">' +
          '<div class="card-head"><div><h3>' + t('sharpenAim') + '</h3><p class="sub">' + t('sharpenSub') + '</p></div></div>' +
          '<div class="tips-list">' + tips.slice(0, 4).map(function (tip) {
            return '<div class="tip-item"><span class="t-ico">›</span><span>' + esc(tip) + '</span></div>';
          }).join('') + '</div>' +
        '</section>' +
      '</div>' +

      '<div class="grid-2">' +
        chartCard({
          title: t('pipelineFunnel'), subtitle: t('funnelSub'),
          svg: funnelSVG(trFunnel(s.funnel)),
          table: { head: [t('stage'), t('reached')], rows: s.funnel.map(function (f) { return [trStage(f.stage), fmtNum(f.count)]; }) }
        }) +
        '<div>' +
          chartCard({
            title: t('whereOpen'), subtitle: t('inPlay', { n: fmtNum(s.open) }),
            svg: currentStages.length ? hbarsSVG(trFunnel(currentStages.map(function (c) { return { stage: c.label, count: c.count }; })).map(function (x) { return { label: x.stage, count: x.count }; }), { aria: 'Open leads by stage' }) : '<div class="empty">' + t('noOpen') + '</div>',
            table: { head: [t('stage'), t('leads')], rows: currentStages.map(function (c) { return [trStage(c.label), fmtNum(c.count)]; }) }
          }) +
          '<div style="height:16px"></div>' +
          chartCard({
            title: t('outcomeSplit'), subtitle: t('allToDate', { n: fmtNum(s.total) }),
            legend: [{ cls: 'good', label: t('won') }, { cls: 'critical', label: t('lost') }, { cls: 'gray', label: t('unqualified') }, { cls: 's1', label: t('stillOpen') }],
            svg: stackedBarSVG([
              { label: t('closedWon'), count: s.won, cls: 'good' },
              { label: t('closedLost'), count: s.lost, cls: 'critical' },
              { label: t('unqualified'), count: s.unqualified, cls: 'gray' },
              { label: t('stillOpen'), count: s.open, cls: 's1' }
            ]),
            table: { head: [t('outcome'), t('leads')], rows: [[t('closedWon'), fmtNum(s.won)], [t('closedLost'), fmtNum(s.lost)], [t('unqualified'), fmtNum(s.unqualified)], [t('stillOpen'), fmtNum(s.open)]] }
          }) +
        '</div>' +
      '</div>' +

      '<div class="grid-2">' +
        chartCard({
          title: t('leadsByMonth'), subtitle: t('last12'),
          svg: columnsSVG(months.map(function (m) { return m.label; }), byMonth, { aria: 'Leads by month', unit: 'leads' }),
          table: { head: [t('month'), t('leads')], rows: months.map(function (m, i) { return [m.label, fmtNum(byMonth[i])]; }) }
        }) +
        chartCard({
          title: t('winRateTitle'), subtitle: t('winRateSub'),
          svg: lineSVG(months.map(function (m) { return m.label; }), winRate, { pct: true, maxHint: 0.5, aria: 'Win rate trend', nullLabel: t('noDecided') }),
          table: { head: [t('month'), t('winRate')], rows: months.map(function (m, i) { return [m.label, winRate[i] === null ? '—' : fmtPct(winRate[i], 0)]; }) }
        }) +
      '</div>' +

      '<div class="grid-2">' +
        reasonTilesCard(t('whyLost'), t('whyLostSub', { n: fmtNum(s.everLost) }), reasonsLost, 'critical') +
        reasonTilesCard(t('whyUnq'), t('whyUnqSub', { n: fmtNum(s.everUnqualified) }), reasonsUnq, 'gray') +
      '</div>';
  }

  /* ---- My Leads ---- */
  function viewLeads(content, user) {
    if (!leadsOf(user.id).length) {
      content.innerHTML = emptyState('leads', t('noLeadsTitle'), t('noLeadsBody'), '/submit', t('navSubmit'));
      return;
    }
    var stageFilter = 'all';
    var q = '';

    function renderTable() {
      var leads = leadsOf(user.id).filter(function (l) {
        if (stageFilter === 'open' && !isOpen(l)) return false;
        if (stageFilter !== 'all' && stageFilter !== 'open' && l.stage !== stageFilter) return false;
        if (q) {
          var hay = (l.company + ' ' + l.contact + ' ' + l.industry + ' ' + l.salesOwner).toLowerCase();
          if (hay.indexOf(q.toLowerCase()) === -1) return false;
        }
        return true;
      });
      var rows = leads.map(function (l) {
        var comm = l.stage === 'won' ? '<span class="money-pos">' + fmtMoneyC(commissionOf(l)) + '</span>'
          : (isOpen(l) && l.amountNet) ? '<span class="cell-sub">' + t('potential', { v: fmtMoneyC(l.amountNet * COMMISSION_RATE) }) + '</span>' : '—';
        return '<tr class="rowlink" data-lead="' + l.id + '" tabindex="0">' +
          '<td><b>' + esc(l.company) + '</b><span class="cell-sub">' + [l.contact, trCity(l.city)].filter(Boolean).map(esc).join(' · ') + '</span></td>' +
          '<td>' + esc(trCat(l.industry)) + '</td>' +
          '<td>' + fmtDate(l.createdAt) + '</td>' +
          '<td>' + stagePill(l.stage) + '</td>' +
          '<td>' + (l.salesOwner === 'Unassigned' ? t('unassigned') : esc(l.salesOwner)) + '</td>' +
          '<td>' + fmtDate(lastActivity(l)) + '</td>' +
          '<td class="num">' + (l.amountNet ? fmtMoneyC(l.amountNet) : '<span class="cell-sub">' + t('toBeScoped') + '</span>') +
            (l.plan ? '<span class="cell-sub">' + esc(trPlan(l.plan)) + (l.years === 2 ? t('twoYr') : '') + '</span>' : '') + '</td>' +
          '<td class="num">' + comm + '</td>' +
        '</tr>';
      }).join('');
      document.getElementById('leads-table').innerHTML =
        '<div class="tbl-wrap"><table>' +
          '<thead><tr><th>' + t('merchant') + '</th><th>' + t('category') + '</th><th>' + t('submitted') + '</th><th>' + t('stage') + '</th><th>' + t('dealOwner') + '</th><th>' + t('lastActivity') + '</th><th class="num">' + t('valueExVat') + '</th><th class="num">' + t('commissionCol') + '</th></tr></thead>' +
          '<tbody>' + (rows || '<tr><td colspan="8"><div class="empty">' + t('noLeadsFilter') + '</div></td></tr>') + '</tbody>' +
        '</table></div>';
      document.querySelectorAll('[data-lead]').forEach(function (tr) {
        function open() { openDrawer(tr.getAttribute('data-lead')); }
        tr.addEventListener('click', open);
        tr.addEventListener('keydown', function (e) { if (e.key === 'Enter') open(); });
      });
    }

    var segStages = [['all', t('all')], ['open', t('open')], ['won', t('won')], ['lost', t('lost')], ['unqualified', t('unqualified')]];
    content.innerHTML =
      '<div class="filter-row">' +
        '<div class="seg" id="stage-seg">' + segStages.map(function (s, i) {
          return '<button data-seg="' + s[0] + '" class="' + (i === 0 ? 'active' : '') + '">' + s[1] + '</button>';
        }).join('') + '</div>' +
        '<div class="spacer"></div>' +
        '<input type="text" class="search-input" id="lead-search" placeholder="' + t('searchPh') + '">' +
        '<a href="#/submit" class="btn" style="text-decoration:none">' + t('submitLeadBtn') + '</a>' +
      '</div>' +
      '<div class="card" id="leads-table"></div>';

    document.querySelectorAll('#stage-seg button').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('#stage-seg button').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        stageFilter = b.getAttribute('data-seg');
        renderTable();
      });
    });
    document.getElementById('lead-search').addEventListener('input', function (e) {
      q = e.target.value; renderTable();
    });
    renderTable();
  }

  /* ---- Lead drawer ---- */
  var STAGE_STORY = {
    new: 'Lead received and routed to the sales pipeline.',
    prospect: 'Sales began outreach and discovery.',
    qualified: 'Qualified by the pre-sales team — real opportunity confirmed.',
    sql: 'Sales-qualified: budget and decision maker identified.',
    commit: 'Verbal commitment — contract in final negotiation.',
    won: 'Deal signed. Commission unlocked.',
    lost: 'Deal closed lost.',
    unqualified: 'Marked unqualified by pre-sales.',
    reengage: 'Parked for re-engagement — sales will retry next quarter.'
  };

  function openDrawer(leadId) {
    var lead = allLeads().find(function (l) { return l.id === leadId; });
    if (!lead) return;
    var old = document.getElementById('drawer-root');
    if (old) old.remove();

    var timeline = lead.events.map(function (e) {
      var cls = e.stage === 'won' ? 'won' : e.stage === 'lost' ? 'lost' : e.stage === 'unqualified' ? 'unq' : '';
      return '<li class="' + cls + '"><span class="t-dot"></span>' +
        '<b>' + esc(trStage(STAGE_BY_ID[e.stage].label)) + '</b>' +
        '<span class="t-date">' + fmtDate(e.date) + '</span>' +
        '<p>' + esc((isAr() ? STORY_AR[e.stage] : STAGE_STORY[e.stage]) || '') + '</p></li>';
    }).join('');

    var commissionRow = '';
    if (lead.stage === 'won') {
      var cs = commissionStatus(lead);
      commissionRow =
        '<dt>' + t('commissionPct', { rate: ratePct() }) + '</dt><dd class="money-pos">' + fmtMoney(commissionOf(lead)) +
        ' <span class="status-chip ' + cs + '">' + statusLabel(cs) + '</span></dd>';
    }
    var reasonRow = '';
    if (lead.stage === 'lost' && lead.lostReason) reasonRow = '<dt>' + t('lostReason') + '</dt><dd>' + esc(trReason(lead.lostReason)) + '</dd>';
    if (lead.stage === 'unqualified' && lead.unqualReason) reasonRow = '<dt>' + t('unqReason') + '</dt><dd>' + esc(trReason(lead.unqualReason)) + '</dd>';

    var root = el('<div id="drawer-root">' +
      '<div class="drawer-backdrop"></div>' +
      '<div class="drawer" role="dialog" aria-label="Lead detail">' +
        '<div class="d-head"><div><h2>' + esc(lead.company) + '</h2>' +
        '<p class="sub">' + [lead.contact, trCat(lead.industry), trCity(lead.city)].filter(Boolean).map(esc).join(' · ') + '</p></div>' +
        '<button class="icon-btn" id="drawer-close" aria-label="Close">✕</button></div>' +
        '<span class="hs-chip">' + t('synced', { id: esc(lead.id) }) + '</span>' +
        '<dl class="d-kv">' +
          '<dt>' + t('stage') + '</dt><dd>' + stagePill(lead.stage) + '</dd>' +
          '<dt>' + t('dealOwner') + '</dt><dd>' + (lead.salesOwner === 'Unassigned' ? t('unassigned') : esc(lead.salesOwner)) + '</dd>' +
          (lead.plan ? '<dt>' + t('packageLbl') + '</dt><dd>' + t('zidPlan', { name: esc(trPlan(lead.plan)) }) + (lead.years === 2 ? t('yearTwo') : t('yearOne')) + '</dd>' : '') +
          (lead.source ? '<dt>' + t('source') + '</dt><dd>' + esc(trSource(lead.source)) + '</dd>' : '') +
          (lead.platform ? '<dt>' + t('platform') + '</dt><dd>' + esc(lead.platform) + '</dd>' : '') +
          (lead.storeUrl ? '<dt>' + t('currentStore') + '</dt><dd><a href="' + esc(lead.storeUrl) + '" target="_blank" rel="noopener">' + esc(lead.storeUrl) + '</a></dd>' : '') +
          (lead.contactEmail ? '<dt>' + t('merchantEmail') + '</dt><dd>' + esc(lead.contactEmail) + '</dd>' : '') +
          (lead.phone ? '<dt>' + t('mobile') + '</dt><dd>' + esc(lead.phone) + '</dd>' : '') +
          '<dt>' + t('submitted') + '</dt><dd>' + fmtDate(lead.createdAt) + '</dd>' +
          (lead.amountNet
            ? '<dt>' + t('valueExVat') + '</dt><dd>' + fmtMoney(lead.amountNet) + '</dd>' +
              '<dt>' + t('valueIncVat') + '</dt><dd>' + fmtMoney(grossOf(lead)) + '</dd>'
            : '<dt>' + t('valueLbl') + '</dt><dd>' + t('scopedBySales') + '</dd>') +
          commissionRow + reasonRow +
        '</dl>' +
        (lead.notes ? '<h3 class="eyebrow">' + t('hunterNotes') + '</h3><p class="sub" style="margin:6px 0 12px">' + esc(lead.notes) + '</p>' : '') +
        '<h3 class="eyebrow">' + t('timeline') + '</h3>' +
        '<ul class="timeline">' + timeline + '</ul>' +
      '</div></div>');
    document.body.appendChild(root);
    var release = trapOverlay(root.querySelector('.drawer'), function () { close(); });
    function close() { release(); root.remove(); }
    root.querySelector('.drawer-backdrop').addEventListener('click', close);
    root.querySelector('#drawer-close').addEventListener('click', close);
  }

  /* ---- Submit lead (mirrors the real referral form) ---- */
  function viewSubmit(content, user) {
    // Submitting would file a lead under this hunter's name, so the whole
    // form is withheld while management is only looking.
    if (readOnlyView()) { content.innerHTML = readOnlyNotice(t('submitBlocked')); return; }
    /* Live: embed the real HubSpot form — same form the program already
       uses, so submissions land in the existing pipeline and workflow.
       The hunter's Zid email is prefilled for commission attribution.
       Demo mode keeps the native form so the showcase never writes to
       HubSpot. */
    if (window.LIVE) { renderHubspotForm(content, user); return; }
    var radios = PLATFORMS.map(function (p, i) {
      return '<label class="radio-row"><input type="radio" name="f-platform" value="' + esc(p) + '"' + (i === -1 ? ' checked' : '') + '><span>' + esc(p) + '</span></label>';
    }).join('');

    content.innerHTML =
      '<div class="card" style="max-width:720px">' +
        '<h2>' + t('submitTitle') + '</h2>' +
        '<p class="sub">' + t('submitSub') + '</p>' +
        '<form id="lead-form" style="margin-top:16px">' +
          '<div class="form-grid">' +
            '<div><label class="f-label" for="f-company">' + t('merchantNameLbl') + '</label><input type="text" id="f-company" required></div>' +
            '<div><label class="f-label" for="f-email">' + t('merchantEmail') + '</label><input type="email" id="f-email" placeholder="name@store.com"></div>' +
            '<div><label class="f-label" for="f-phone">' + t('phoneReq') + '</label><input type="tel" id="f-phone" required placeholder="+966 5X XXX XXXX"></div>' +
            '<div><label class="f-label" for="f-industry">' + t('industryLbl') + '</label>' +
              '<input type="text" id="f-industry" list="industry-list" placeholder="' + t('industryPh') + '">' +
              '<datalist id="industry-list">' + INDUSTRIES.map(function (i) { return '<option value="' + esc(i) + '">' + esc(trCat(i)) + '</option>'; }).join('') + '</datalist></div>' +
            '<div class="full"><span class="f-label">' + t('platformLbl') + '</span>' +
              '<div class="radio-list" id="f-platform-group">' + radios + '</div></div>' +
            '<div class="full"><label class="f-label" for="f-store">' + t('storeLink') + '</label>' +
              '<input type="url" id="f-store" placeholder="https://">' +
              '<p class="f-hint">' + t('storeLinkHint') + '</p></div>' +
            '<div class="full"><label class="f-label" for="f-notes">' + t('extraNotes') + '</label>' +
              '<textarea id="f-notes" rows="3"></textarea>' +
              '<p class="f-hint">' + t('extraNotesHint') + '</p></div>' +
            '<div class="full"><label class="f-label" for="f-owner">' + t('leadOwnerEmail') + '</label>' +
              '<input type="email" id="f-owner" value="' + esc(user.email || '') + '" readonly>' +
              '<p class="f-hint">' + t('ownerAutoHint') + '</p></div>' +
          '</div>' +
          '<div style="margin-top:16px; display:flex; gap:10px; align-items:center">' +
            '<button type="submit" class="btn">' + t('submitBtn') + '</button>' +
            '<span class="sub">' + t('dupNote') + '</span>' +
          '</div>' +
        '</form>' +
      '</div>';

    document.getElementById('lead-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var company = document.getElementById('f-company').value.trim();
      var phone = document.getElementById('f-phone').value.trim();
      var platformEl = document.querySelector('input[name="f-platform"]:checked');
      if (!company || !phone || !platformEl) { toast(t('submitReqErr')); return; }
      var industry = document.getElementById('f-industry').value.trim();
      if (window.LIVE) {
        SH_API.submitLead({
          company: company, industry: industry, platform: platformEl.value,
          storeUrl: document.getElementById('f-store').value.trim(),
          contactEmail: document.getElementById('f-email').value.trim(),
          phone: phone,
          notes: document.getElementById('f-notes').value.trim()
        }).then(function () {
          toast(t('submittedToast'));
          location.hash = '#/leads';
        }).catch(function (e2) { toast(String(e2.message)); });
        return;
      }
      // Anchor to the demo's frozen "today" so the lead lands inside every
      // monthly chart window (the whole dataset lives at NOW).
      var now = new Date(NOW.getTime());
      var leads = LS.get('leads', []);
      leads.unshift({
        id: 'L-N' + (1000 + leads.length + 1),
        hunterId: user.id,
        company: company,
        contact: '',
        contactEmail: document.getElementById('f-email').value.trim(),
        phone: phone,
        platform: platformEl.value,
        storeUrl: document.getElementById('f-store').value.trim(),
        notes: document.getElementById('f-notes').value.trim(),
        ownerEmail: document.getElementById('f-owner').value.trim(),
        plan: null,
        years: 1,
        industry: industry || INDUSTRIES[0],
        city: '',
        source: null,
        createdAt: now.toISOString(),
        stage: 'new',
        events: [{ stage: 'new', date: now.toISOString() }],
        amountNet: 0, // sales will scope the package
        lostReason: null, unqualReason: null,
        salesOwner: 'Unassigned'
      });
      LS.set('leads', leads);
      toast(t('submittedToast'));
      location.hash = '#/leads';
    });
  }

  /* HubSpot form config (portal 4731529 → the Sales Hunter lead form) */
  var HS_PORTAL = '4731529';
  var HS_FORM = '220db1da-0224-436d-bc30-06381a1f1a55';
  var HS_REGION = 'na1';

  /* Set an input's value so HubSpot's validation registers it. */
  function setNativeValue(input, value) {
    var proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    if (proto && proto.set) proto.set.call(input, value); else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  /* Find the "Lead Owner Email" field on the HubSpot form and lock the
     hunter's Zid email into it. onFormReady may hand us a jQuery object
     OR the raw <form> element — and a <form> has a numeric .length (its
     field count), so we must detect jQuery by its .jquery marker, not by
     .length. The field's internal name is unknown, so match by candidate
     names, then by any label/placeholder reading like "owner email". */
  function prefillOwnerEmail($form, email) {
    try {
      var f = ($form && $form.jquery) ? $form[0] : $form;
      if (!f || !f.querySelector) return false;
      var input = null;
      var names = ['lead_owner_email', 'lead_by__zidder_email_', 'owner_email',
        'hunter_email', 'zidder_email', 'employee_email'];
      for (var i = 0; i < names.length && !input; i++) {
        input = f.querySelector('input[name="' + names[i] + '"]');
      }
      if (!input) {
        var labels = f.querySelectorAll('label');
        for (var j = 0; j < labels.length && !input; j++) {
          var txt = ((labels[j].textContent || '') + ' ' + (labels[j].getAttribute('placeholder') || '')).toLowerCase();
          if (txt.indexOf('owner') >= 0 && txt.indexOf('email') >= 0) {
            var forId = labels[j].getAttribute('for');
            if (forId) input = f.querySelector('#' + CSS.escape(forId));
            if (!input) {
              var box = labels[j].closest('.hs-form-field') || labels[j].parentElement;
              if (box) input = box.querySelector('input[type="email"], input[type="text"]');
            }
          }
        }
      }
      if (!input) return false;
      setNativeValue(input, email); // prefilled but editable
      return true;
    } catch (e) { return false; }
  }

  // Tracked outside renderHubspotForm, at module scope, so a re-render
  // can find and stop a still-running poll from the PREVIOUS call.
  // language/theme toggles both call route() — if one lands while the
  // embed script is still loading, the old render's setInterval kept
  // polling after content.innerHTML had already been replaced. Once the
  // script did load, hbspt.forms.create() targets '#hs-form-slot' by CSS
  // selector, which resolves to whatever element currently has that id —
  // the NEW slot, not a stale reference — so the old interval's build()
  // landed in the same container as the new render's and embedded the
  // lead form twice. Also kept polling for up to ~15s past navigating
  // away from /submit entirely.
  var hsPollInterval = null;

  function renderHubspotForm(content, user) {
    if (hsPollInterval) { clearInterval(hsPollInterval); hsPollInterval = null; }
    content.innerHTML =
      '<div class="card hs-panel" style="max-width:760px">' +
        '<div id="hs-form-slot" style="min-height:120px">' +
          '<p class="sub" id="hs-loading">' + t('hsLoading') + '</p></div>' +
      '</div>';

    function build() {
      if (!(window.hbspt && window.hbspt.forms)) return false;
      var loading = document.getElementById('hs-loading');
      if (loading) loading.remove();
      window.hbspt.forms.create({
        portalId: HS_PORTAL, formId: HS_FORM, region: HS_REGION,
        target: '#hs-form-slot',
        onFormReady: function ($form) {
          prefillOwnerEmail($form, user.email);
        },
        onFormSubmitted: function () {
          toast(t('hsSubmitted'));
        }
      });
      return true;
    }

    if (build()) return;
    // load the embed script once, then build
    if (!document.getElementById('hs-embed-js')) {
      var sc = document.createElement('script');
      sc.id = 'hs-embed-js';
      sc.src = 'https://js.hsforms.net/forms/embed/v2.js';
      sc.charset = 'utf-8';
      document.head.appendChild(sc);
    }
    var tries = 0;
    hsPollInterval = setInterval(function () {
      tries++;
      if (build() || tries > 60) { clearInterval(hsPollInterval); hsPollInterval = null; }
      if (tries > 60) {
        var slot = document.getElementById('hs-form-slot');
        if (slot) slot.innerHTML = '<p class="f-error">' + t('hsFailed') + '</p>';
      }
    }, 250);
  }

  /* ---- Commission ---- */
  function viewCommission(content, user) {
    var leads = leadsOf(user.id);
    if (!leads.filter(function (l) { return l.stage === 'won'; }).length) {
      content.innerHTML = emptyState('money', t('noCommTitle'),
        t('noCommBody', { rate: ratePct() }), leads.length ? '/leads' : '/submit',
        leads.length ? t('navLeads') : t('navSubmit'));
      return;
    }
    var s = statsFor(leads);
    var months = last12Months();
    var thisMonthKey = monthKey(NOW);
    var lastMonthKey = monthKey(new Date(NOW.getFullYear(), NOW.getMonth() - 1, 1));

    var wonLeads = leads.filter(function (l) { return l.stage === 'won'; })
      .sort(function (a, b) { return wonDate(b) - wonDate(a); });

    function commInMonth(key) {
      return wonLeads.filter(function (l) { return monthKey(wonDate(l)) === key; })
        .reduce(function (a, l) { return a + commissionOf(l); }, 0);
    }

    var revByMonth = months.map(function (m) {
      return wonLeads.filter(function (l) { return monthKey(wonDate(l)) === m.key; })
        .reduce(function (a, l) { return a + l.amountNet; }, 0);
    });
    var commByMonth = months.map(function (m) { return commInMonth(m.key); });

    var example = wonLeads[0];
    var mathCard = '';
    if (example) {
      mathCard =
        '<section class="card">' +
          '<div class="card-head"><div><h3>' + t('howCalc') + '</h3>' +
          '<p class="sub">' + t('calcExample', { name: esc(example.company) }) + '</p></div></div>' +
          '<div class="math-steps">' +
            '<div class="math-step"><div class="m-label">' + t('subIncVat') + '</div><div class="m-value">' + fmtMoney(grossOf(example)) + '</div><div class="m-note">' + t('customerPays') + '</div></div>' +
            '<div class="math-step"><div class="m-label">' + t('removeVat', { vat: vatPct(), div: (1 + VAT_RATE).toFixed(2) }) + '</div><div class="m-value">' + fmtMoney(example.amountNet) + '</div><div class="m-note">' + t('netValue') + '</div></div>' +
            '<div class="math-step result"><div class="m-label">' + t('yourCommission', { rate: ratePct() }) + '</div><div class="m-value">' + fmtMoney(commissionOf(example)) + '</div><div class="m-note">' + t('paidAfter') + '</div></div>' +
          '</div>' +
        '</section>';
    }

    var histRows = wonLeads.map(function (l) {
      var cs = commissionStatus(l);
      return '<tr>' +
        '<td><b>' + esc(l.company) + '</b><span class="cell-sub">' + esc(l.id) + '</span></td>' +
        '<td>' + fmtDate(wonDate(l)) + '</td>' +
        '<td class="num">' + fmtMoney(l.amountNet) + '</td>' +
        '<td class="num"><b>' + fmtMoney(commissionOf(l)) + '</b></td>' +
        '<td><span class="status-chip ' + cs + '">' + statusLabel(cs) + '</span>' +
          (cs === 'paid' && hasSlip(l.id) ? '<span class="cell-sub">' + slipLink(l.id) + '</span>' : '') + '</td>' +
      '</tr>';
    }).join('');

    content.innerHTML =
      '<div class="card" style="display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:14px">' +
        '<div><span class="eyebrow">' + t('lifetimeCommission') + '</span>' +
        '<div class="hero-figure money-pos">' + fmtMoney(s.commission) + '</div>' +
        '<p class="sub">' + t('fromDeals', { n: fmtNum(s.won), v: fmtMoneyC(s.revenueNet) }) + '</p></div>' +
        '<button class="btn secondary" id="dl-statement">' + t('downloadCsv') + '</button>' +
      '</div>' +

      '<div class="kpis">' +
        tile(t('thisMonth'), fmtMoneyC(commInMonth(thisMonthKey)), '') +
        tile(t('lastMonth'), fmtMoneyC(commInMonth(lastMonthKey)), '') +
        tile(t('pendingApproval'), fmtMoneyC(s.commissionPending), t('awaitingFinance')) +
        tile(t('approvedPayroll'), fmtMoneyC(s.commissionApproved), '') +
        tile(t('paidToDate'), fmtMoneyC(s.commissionPaid), '') +
      '</div>' +

      mathCard +

      chartCard({
        title: t('revVsComm'), subtitle: t('revVsCommSub'),
        legend: [{ cls: 's1', label: t('revGenLegend') }, { cls: 's2', label: t('yourCommLegend', { rate: ratePct() }) }],
        svg: groupedColumnsSVG(months.map(function (m) { return m.label; }), revByMonth, commByMonth,
          { nameA: t('revGenLegend'), nameB: t('yourCommLegend', { rate: ratePct() }), aria: 'Revenue vs commission', W: 1080 }),
        table: { head: [t('month'), t('revenueSar'), t('commissionSar')], rows: months.map(function (m, i) { return [m.label, fmtNum(revByMonth[i]), fmtNum(commByMonth[i])]; }) }
      }) +

      '<section class="card">' +
        '<div class="card-head"><div><h3>' + t('commHistory') + '</h3><p class="sub">' + t('oneRowPerDeal') + '</p></div></div>' +
        '<div class="tbl-wrap"><table>' +
          '<thead><tr><th>' + t('deal') + '</th><th>' + t('closedWon') + '</th><th class="num">' + t('valueExVat') + '</th><th class="num">' + t('commissionCol') + '</th><th>' + t('status') + '</th></tr></thead>' +
          '<tbody>' + (histRows || '<tr><td colspan="5"><div class="empty">' + t('noWonYet') + '</div></td></tr>') + '</tbody>' +
        '</table></div>' +
      '</section>';

    document.getElementById('dl-statement').addEventListener('click', function () {
      var lines = ['Deal ID,Company,Closed Won Date,Subscription (SAR excl. VAT),Commission (SAR),Status'];
      wonLeads.forEach(function (l) {
        lines.push([csvCell(l.id), csvCell(l.company), fmtDate(wonDate(l)), l.amountNet, Math.round(commissionOf(l)), commissionStatus(l)].join(','));
      });
      var blob = new Blob([lines.join('\n')], { type: 'text/csv' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'sales-hunter-commission-statement.csv';
      a.click();
      URL.revokeObjectURL(a.href);
      toast(t('statementDl'));
    });
  }

  /* ---- Leaderboard ---- */
  function badgesFor(empId, s, topThisMonth) {
    var out = [];
    if (s.won >= 1) out.push(t('badgeFirst'));
    if (s.won >= 5) out.push(t('badgeWins'));
    if (s.revenueNet >= 500000) out.push(t('badge500k'));
    if (topThisMonth === empId) out.push(t('badgeTop'));
    if (s.total >= 10 && s.unqualified / s.total < 0.1) out.push(t('badgeSharp'));
    return out;
  }

  /* inRange (optional) scopes the numbers to a period — a predicate over
     leads, see rangePredicate() below. Rows always carry BOTH the scoped stats
     (`s`) and the lifetime ones (`allS`), because not everything on the
     row means the same thing under a filter: badges are achievements
     someone has already earned ("first sale", "5 wins"), so they read off
     `allS` and never shrink when the table is narrowed to a window. */
  function leaderboardData(inRange) {
    var thisMonthKey = monthKey(NOW);
    var rows = EMPLOYEES.map(function (e) {
      var leads = leadsOf(e.id);
      var s = statsFor(inRange ? leads.filter(inRange) : leads);
      var allS = inRange ? statsFor(leads) : s;
      // "Top hunter this month" is likewise an award about the current
      // month, not about whatever window happens to be on screen — so it
      // is measured on the full history either way.
      var revThisMonth = leads.filter(function (l) {
        return l.stage === 'won' && monthKey(wonDate(l)) === thisMonthKey;
      }).reduce(function (a, l) { return a + l.amountNet; }, 0);
      return { emp: e, s: s, allS: allS, revThisMonth: revThisMonth };
    });
    var topThisMonth = rows.slice().sort(function (a, b) { return b.revThisMonth - a.revThisMonth; })[0];
    return { rows: rows, topThisMonthId: topThisMonth && topThisMonth.revThisMonth > 0 ? topThisMonth.emp.id : null };
  }

  /* Hunters with real deals (hunterId is just their lowercased email —
     see toLead() in api.js) but no app_users account yet. Nothing to
     "link" later: the moment someone registers with that same email,
     EMPLOYEES picks them up and leadsOf() matches their existing deals
     automatically, since attribution is the email itself. */
  // Real CRM deep link. sync-hubspot writes the connected account's portal
  // id into settings, so this follows whichever portal is connected rather
  // than being hardcoded. Returns null in demo mode, where there is no
  // real deal to open.
  function hubspotDealUrl(dealId) {
    var st = (window.LIVE && window.LIVE.settings) || {};
    if (!st.hubspot_portal_id) return null;
    return 'https://' + (st.hubspot_ui_domain || 'app.hubspot.com') +
      '/contacts/' + st.hubspot_portal_id + '/record/0-3/' + encodeURIComponent(dealId);
  }

  function hubspotLinkHtml(dealId) {
    var url = hubspotDealUrl(dealId);
    return url
      ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + t('openHubspot') + '</a>'
      : '<a href="#" class="hs-link" data-deal="' + esc(dealId) + '">' + t('openHubspot') + '</a>';
  }

  // Paid merchants whose HubSpot deal is still open. Collapsed to two
  // numbers by default; expanding lists them with a link straight to the
  // record that needs fixing.
  function pendingClosureCard(rows, amount) {
    cardSeq += 1;
    var id = 'pc' + cardSeq;
    var head =
      '<div class="card-head"><div><h3>' + t('pendingClosure') + '</h3>' +
      '<p class="sub">' + t('pendingClosureSub') + '</p></div>' +
      '<button class="ghost-btn" data-toggle-pending="' + id + '" aria-expanded="false">' + t('viewDeals') + '</button></div>';
    var tiles =
      '<div class="reason-tiles">' +
        '<div class="reason-tile"><div class="rt-value warning">' + fmtNum(rows.length) + '</div>' +
        '<div class="rt-label">' + t('pendingClosureCount') + '</div></div>' +
        '<div class="reason-tile"><div class="rt-value warning">' + fmtMoney(amount) + '</div>' +
        '<div class="rt-label">' + t('pendingClosureAmount') + '</div></div>' +
      '</div>';
    var table =
      '<div class="tbl-wrap"><table class="mini"><thead><tr>' +
        '<th>' + t('merchant') + '</th><th>' + t('hunter') + '</th><th>' + t('packageCol') + '</th>' +
        '<th>' + t('purchased') + '</th><th class="num">' + t('valueExVat') + '</th><th>' + t('hubspotStageCol') + '</th>' +
      '</tr></thead><tbody>' +
      rows.map(function (l) {
        var hunter = (window.LIVE ? LIVE.users : EMPLOYEES).find(function (e) { return e.id === l.hunterId; });
        return '<tr>' +
          '<td><b>' + esc(l.company) + '</b><span class="cell-sub">' + esc(l.id) + ' · ' + hubspotLinkHtml(l.id) + '</span></td>' +
          '<td>' + (hunter ? '<b>' + esc(hunter.name) + '</b>'
            : l.hunterId === 'unassigned' ? t('unassigned')
            : esc(l.hunterId)) + '</td>' +
          '<td>' + esc(l.plan || '—') + '</td>' +
          '<td>' + fmtDate(wonDate(l)) + '</td>' +
          '<td class="num">' + fmtMoney(l.amountNet) + '</td>' +
          '<td>' + esc(l.hubspotStage || '—') + '</td>' +
        '</tr>';
      }).join('') +
      '</tbody></table></div>';
    return '<section class="card" id="' + id + '">' + head + tiles +
      '<div class="pending-list" hidden>' + table + '</div></section>';
  }

  function wirePendingToggles(root) {
    root.querySelectorAll('[data-toggle-pending]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var card = document.getElementById(btn.getAttribute('data-toggle-pending'));
        var list = card.querySelector('.pending-list');
        var show = list.hidden;
        list.hidden = !show;
        btn.setAttribute('aria-expanded', String(show));
        btn.textContent = show ? t('hideDeals') : t('viewDeals');
      });
    });
  }

  // Reason tiles rank the recorded reasons, then append the deals still
  // parked in the stage with nothing recorded — a data-hygiene number that
  // belongs on the card but is not itself a reason, so it always sorts last.
  function reasonTiles(bucket, noReason) {
    var out = Object.keys(bucket)
      .map(function (k) { return { label: reasonLabel(k), count: bucket[k] }; })
      .sort(function (a, b) { return b.count - a.count; });
    if (noReason) out.push({ label: t('noReasonGiven'), count: noReason });
    return out;
  }

  function unregisteredHunterRows(inRange) {
    var known = {};
    EMPLOYEES.forEach(function (e) {
      known[e.id] = true;
      (e.aliases || []).forEach(function (a) { known[a] = true; });
    });
    var seen = {};
    var out = [];
    allLeads().forEach(function (l) {
      var id = l.hunterId;
      if (!id || id === 'unassigned' || known[id] || seen[id]) return;
      seen[id] = true;
      var local = id.split('@')[0].replace(/[._]+/g, ' ').trim();
      var name = local.replace(/\w\S*/g, function (w) { return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); });
      // The hunter is discovered from the UNFILTERED lead list, then scored
      // on the window — so someone whose only deals fall outside it still
      // resolves to a row (an all-zero one the period view then drops)
      // rather than the roster changing shape with the filter.
      var hLeads = leadsOf(id);
      var hs = statsFor(inRange ? hLeads.filter(inRange) : hLeads);
      out.push({ emp: { id: id, name: name || id, dept: '', title: '', email: id, avatar: null }, s: hs, allS: hs });
    });
    return out;
  }

  /* ---- Date-range filter ----
     Everything resolves against NOW, the app's single "today" (a fixed
     date in demo mode, the real clock in live mode — see api.js), so the
     presets agree with every other "this month" in the app.
     A range is {from, to} of inclusive day boundaries; a null bound is
     open-ended, and {null, null} means no filtering at all. */
  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function endOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999); }

  var PERF_RANGES = {
    all: function () { return { from: null, to: null }; },
    d30: function () { return { from: startOfDay(new Date(NOW.getTime() - 29 * DAY)), to: endOfDay(NOW) }; },
    d90: function () { return { from: startOfDay(new Date(NOW.getTime() - 89 * DAY)), to: endOfDay(NOW) }; },
    mtd: function () { return { from: new Date(NOW.getFullYear(), NOW.getMonth(), 1), to: endOfDay(NOW) }; },
    lastMonth: function () {
      // Day 0 of this month is the last day of the previous one.
      return { from: new Date(NOW.getFullYear(), NOW.getMonth() - 1, 1),
               to: endOfDay(new Date(NOW.getFullYear(), NOW.getMonth(), 0)) };
    },
    qtd: function () { return { from: new Date(NOW.getFullYear(), Math.floor(NOW.getMonth() / 3) * 3, 1), to: endOfDay(NOW) }; },
    ytd: function () { return { from: new Date(NOW.getFullYear(), 0, 1), to: endOfDay(NOW) }; }
  };

  /* <input type="date"> speaks 'YYYY-MM-DD'. new Date(that) parses it as
     UTC midnight, which lands on the previous day for anyone west of
     Greenwich and shifts every boundary by one — so build the local date
     from the parts instead. */
  function parseDayInput(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || '');
    if (!m) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3]);
    return isNaN(d.getTime()) ? null : d;
  }
  function toDayInput(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
      '-' + String(d.getDate()).padStart(2, '0');
  }

  /* A lead belongs to the window by when it was SUBMITTED, not by when it
     closed. That keeps the window a cohort: the leads counted are exactly
     the ones the conversion rates are measured over, so "35 leads, 20%
     reached SQL" is always 7 of those same 35. Scoring revenue by close
     date instead would let won deals outnumber the leads in the window and
     push conversion past 100%. */
  function rangePredicate(r) {
    if (!r || (!r.from && !r.to)) return null;
    return function (l) {
      var d = l.createdAt;
      return (!r.from || d >= r.from) && (!r.to || d <= r.to);
    };
  }

  /* Management-only ranking (replaces the shared leaderboard — hunters
     see only their own numbers, for privacy) */
  function viewPerformance(content) {
    var regFilter = 'all';
    var rangeKey = 'all';
    // Custom bounds live outside the preset table so switching away to a
    // preset and back does not lose what was typed.
    var custom = { from: null, to: null };

    var RANGE_OPTS = [
      ['all', 'rangeAll'], ['mtd', 'rangeMtd'], ['lastMonth', 'rangeLastMonth'],
      ['d30', 'range30'], ['d90', 'range90'], ['qtd', 'rangeQtd'],
      ['ytd', 'rangeYtd'], ['custom', 'rangeCustom']
    ];

    function currentRange() {
      if (rangeKey !== 'custom') return PERF_RANGES[rangeKey]();
      return { from: custom.from, to: custom.to ? endOfDay(custom.to) : null };
    }
    // Only a custom window can be nonsense; the presets are built from NOW.
    function rangeInvalid() {
      return rangeKey === 'custom' && custom.from && custom.to && custom.from > custom.to;
    }

    function model() {
      var range = currentRange();
      var pred = rangePredicate(range);
      var data = leaderboardData(pred);
      var rows = data.rows.map(function (r) { return Object.assign({ registered: true }, r); })
        .concat(unregisteredHunterRows(pred).map(function (r) { return Object.assign({ registered: false }, r); }));
      if (regFilter === 'reg') rows = rows.filter(function (r) { return r.registered; });
      else if (regFilter === 'unreg') rows = rows.filter(function (r) { return !r.registered; });
      // Under a window, a hunter with nothing submitted in it has no
      // standing to rank — keeping them would pad the table with a tail of
      // identical all-zero rows. All-time keeps everyone, as before, so
      // the roster still shows who has yet to submit anything at all.
      if (pred) rows = rows.filter(function (r) { return r.s.total > 0; });
      rows.sort(function (a, b) { return b.s.revenueNet - a.s.revenueNet; });

      var totals = rows.reduce(function (a, r) {
        a.leads += r.s.total; a.sql += r.s.reachedSql; a.won += r.s.reachedWon;
        a.revenueNet += r.s.revenueNet;
        return a;
      }, { leads: 0, sql: 0, won: 0, revenueNet: 0 });

      return { rows: rows, totals: totals, range: range, topId: data.topThisMonthId };
    }

    function rangeNote(m) {
      var r = m.range, n = fmtNum(m.totals.leads);
      if (!r.from && !r.to) return t('rangeNoteAll', { n: n });
      if (r.from && r.to) return t('rangeNote', { from: fmtDate(r.from), to: fmtDate(r.to), n: n });
      if (r.from) return t('rangeNoteFrom', { from: fmtDate(r.from), n: n });
      return t('rangeNoteTo', { to: fmtDate(r.to), n: n });
    }

    // Percentage plus the raw counts underneath it: 25% off 4 leads and
    // 25% off 400 are the same number and very different facts.
    function convCell(hit, total) {
      if (!total) return '<td class="num">—</td>';
      return '<td class="num">' + fmtPct(hit / total, 0) +
        '<span class="cell-sub">' + t('ofTotal', { n: fmtNum(hit), total: fmtNum(total) }) + '</span></td>';
    }

    function renderSummary(m) {
      var tot = m.totals;
      var tiles = [
        { v: fmtNum(tot.leads), label: t('leads') },
        { v: tot.leads ? fmtPct(tot.sql / tot.leads, 0) : '—', label: t('newToSql'),
          hint: t('ofTotal', { n: fmtNum(tot.sql), total: fmtNum(tot.leads) }) },
        { v: tot.leads ? fmtPct(tot.won / tot.leads, 0) : '—', label: t('newToWon'),
          hint: t('ofTotal', { n: fmtNum(tot.won), total: fmtNum(tot.leads) }) },
        { v: fmtMoneyC(tot.revenueNet), label: t('revenue') }
      ];
      document.getElementById('perf-summary').innerHTML =
        '<div class="tiles-strip"><div class="reason-tiles">' + tiles.map(function (x) {
          return '<div class="reason-tile"' + (x.hint ? ' title="' + esc(x.hint) + '"' : '') + '>' +
            '<div class="rt-value">' + esc(x.v) + '</div>' +
            '<div class="rt-label">' + esc(x.label) + '</div></div>';
        }).join('') + '</div></div>';
    }

    function renderTable(m) {
      var rows = m.rows;
      var maxRev = Math.max.apply(null, rows.map(function (r) { return r.s.revenueNet; }).concat([1]));

      var body = rows.map(function (r, i) {
        var rankCls = i === 0 ? 'top1' : i === 1 ? 'top2' : i === 2 ? 'top3' : '';
        // Lifetime stats, deliberately: see leaderboardData().
        var badges = r.registered ? badgesFor(r.emp.id, r.allS || r.s, m.topId) : [];
        var who = r.registered
          ? esc(trDept(r.emp.dept))
          : '<span class="unreg-pill" title="' + esc(t('notRegisteredHint')) + '">' + t('notRegistered') + '</span>';
        return '<tr>' +
          '<td><span class="rank-badge ' + rankCls + '">' + (i + 1) + '</span></td>' +
          '<td><b>' + esc(r.emp.name) + '</b><span class="cell-sub">' + who + '</span></td>' +
          '<td class="num">' + fmtNum(r.s.total) + '</td>' +
          '<td class="num">' + fmtNum(r.s.won) + '</td>' +
          convCell(r.s.reachedSql, r.s.total) +
          convCell(r.s.reachedWon, r.s.total) +
          '<td style="min-width:120px"><div class="progress-track"><div class="progress-fill" style="width:' + Math.round(r.s.revenueNet / maxRev * 100) + '%"></div></div></td>' +
          '<td class="num"><b>' + fmtMoneyC(r.s.revenueNet) + '</b></td>' +
          '<td class="num">' + fmtMoneyC(r.s.commission) + '</td>' +
          '<td><div class="badges">' + badges.map(function (b) { return '<span class="badge-chip">' + esc(b) + '</span>'; }).join('') + '</div></td>' +
        '</tr>';
      }).join('');

      var empty = rangeKey === 'all' ? t('noHuntersFilter') : t('noHuntersPeriod');

      document.getElementById('perf-table').innerHTML =
        '<div class="tbl-wrap"><table>' +
          '<thead><tr><th></th><th>' + t('hunter') + '</th><th class="num">' + t('leads') + '</th>' +
          '<th class="num">' + t('won') + '</th>' +
          '<th class="num" title="' + esc(t('newToSqlHint')) + '">' + t('newToSql') + '</th>' +
          '<th class="num" title="' + esc(t('newToWonHint')) + '">' + t('newToWon') + '</th>' +
          '<th>' + t('revenue') + '</th><th class="num"></th><th class="num">' + t('commissionCol') + '</th>' +
          '<th>' + t('achievements') + '</th></tr></thead>' +
          '<tbody>' + (body || '<tr><td colspan="10"><div class="empty">' + empty + '</div></td></tr>') + '</tbody>' +
        '</table></div>';
    }

    function renderAll() {
      var custWrap = document.getElementById('range-custom');
      custWrap.hidden = rangeKey !== 'custom';

      var note = document.getElementById('perf-range-note');
      if (rangeInvalid()) {
        note.className = 'sub err';
        note.textContent = t('rangeInvalid');
        document.getElementById('perf-summary').innerHTML = '';
        document.getElementById('perf-table').innerHTML =
          '<div class="empty">' + t('rangeInvalid') + '</div>';
        return;
      }
      var m = model();
      note.className = 'sub';
      note.textContent = rangeNote(m);
      document.getElementById('perf-title').textContent =
        rangeKey === 'all' ? t('allTimeRanking') : t('periodRanking');
      renderSummary(m);
      renderTable(m);
    }

    var segOpts = [['all', t('all')], ['reg', t('registered')], ['unreg', t('notRegistered')]];
    var today = toDayInput(NOW);
    content.innerHTML =
      '<section class="card">' +
        '<div class="card-head"><div><h3 id="perf-title">' + t('allTimeRanking') + '</h3>' +
        '<p class="sub">' + t('rankingSub') + '</p>' +
        '<p class="sub" id="perf-range-note"></p></div>' +
        '<div class="seg" id="reg-seg">' + segOpts.map(function (s, i) {
          return '<button data-seg="' + s[0] + '" class="' + (i === 0 ? 'active' : '') + '">' + s[1] + '</button>';
        }).join('') + '</div>' +
        '</div>' +
        '<div class="filter-bar">' +
          '<div class="seg" id="range-seg">' + RANGE_OPTS.map(function (o, i) {
            return '<button data-range="' + o[0] + '" class="' + (i === 0 ? 'active' : '') + '">' + t(o[1]) + '</button>';
          }).join('') + '</div>' +
          '<div class="date-range" id="range-custom" hidden>' +
            '<label class="f-label" for="range-from">' + t('dateFrom') + '</label>' +
            '<input type="date" id="range-from" max="' + today + '">' +
            '<label class="f-label" for="range-to">' + t('dateTo') + '</label>' +
            '<input type="date" id="range-to" max="' + today + '">' +
          '</div>' +
        '</div>' +
        '<div id="perf-summary"></div>' +
        '<div id="perf-table"></div>' +
      '</section>';

    document.querySelectorAll('#reg-seg button').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('#reg-seg button').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        regFilter = b.getAttribute('data-seg');
        renderAll();
      });
    });

    var fromInput = document.getElementById('range-from');
    var toInput = document.getElementById('range-to');
    document.querySelectorAll('#range-seg button').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('#range-seg button').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        rangeKey = b.getAttribute('data-range');
        // Opening Custom on empty inputs would show "all time" under a
        // label that says otherwise; seed it from the last 30 days so the
        // pickers start somewhere the user can adjust rather than fill in.
        if (rangeKey === 'custom' && !custom.from && !custom.to) {
          var seed = PERF_RANGES.d30();
          custom.from = seed.from; custom.to = startOfDay(seed.to);
          fromInput.value = toDayInput(custom.from);
          toInput.value = toDayInput(custom.to);
        }
        renderAll();
      });
    });
    [fromInput, toInput].forEach(function (input) {
      input.addEventListener('change', function () {
        custom.from = parseDayInput(fromInput.value);
        custom.to = parseDayInput(toInput.value);
        renderAll();
      });
    });

    renderAll();
  }

  // Access picker (Team page): at most one open at a time. Tracked here,
  // outside viewTeam, so a single delegated click listener — registered
  // once for the app's whole lifetime — can close and commit whichever
  // picker is open, regardless of which render created it. wireAccessPickers
  // used to add its own `document.addEventListener('click', closeMenu)` per
  // row on every render() (search keystrokes, pagination, saves all call
  // render()), which both leaked listeners without bound and left stale
  // ones closing over detached checkboxes — clicking anywhere after a
  // re-render could silently commit an old snapshot over a newer save.
  var openAccessPicker = null;
  document.addEventListener('click', function () {
    if (openAccessPicker) openAccessPicker();
  });

  /* ---- Management backoffice: team & access ---- */
  function viewTeam(content, user) {
    function saveOverride(id, patch) {
      var over = LS.get('userOverrides', {});
      over[id] = Object.assign(over[id] || {}, patch);
      LS.set('userOverrides', over);
    }

    var editingId = null, page = 1, PER = 10, query = '';
    var ROLE_OPTS = ['emp', 'mgr', 'fin'];
  var ACCESS_HINT = { emp: 'accessHintHunter', mgr: 'accessHintMgmt', fin: 'accessHintFin' };

    function roleBadge(r) { return '<span class="role-badge ' + r + '">' + roleName(r) + '</span>'; }

    // Accesses are a set, not a primary plus a spare, so they get one
    // control: a summary button that opens a checkbox list. Beats stacking
    // a select per access in a table cell, and scales past two.
    function accessPicker(u, isSelf) {
      var held = accessesOf(u);
      // One access needs no count and no list — repeating the same word
      // twice reads as a glitch.
      var single = held.length === 1;
      var summary = single ? roleName(held[0]) : t('nSelected', { n: held.length });
      return '<div class="ms" data-user="' + esc(u.id) + '">' +
        '<button type="button" class="ms-trigger" aria-haspopup="listbox" aria-expanded="false">' +
          '<span class="ms-summary">' + esc(summary) + '</span>' +
          (single ? '<span class="ms-sub"></span>'
                  : '<span class="ms-sub">' + esc(held.map(roleName).join(' · ')) + '</span>') +
          ICONS.chevronDown +
        '</button>' +
        '<div class="ms-menu" hidden role="listbox" aria-multiselectable="true">' +
          ROLE_OPTS.map(function (r) {
            var on = held.indexOf(r) >= 0;
            var isPrimary = r === u.role;
            // Only the Team page can grant access, and only management can
            // reach it — so letting someone drop their own management
            // access locks the last admin out of the app for good.
            var locked = isSelf && r === 'mgr';
            return '<label class="ms-opt' + (on ? ' on' : '') + (locked ? ' locked' : '') + '" role="option" aria-selected="' + on + '"' +
              (locked ? ' title="' + esc(t('ownAccessLocked')) + '"' : '') + '>' +
              '<input type="checkbox" value="' + r + '"' + (on ? ' checked' : '') + (locked ? ' disabled' : '') + '>' +
              '<span class="ms-box">' + ICONS.tick + '</span>' +
              '<span class="ms-txt"><b>' + roleName(r) + '</b>' +
              '<span class="ms-hint">' + t(ACCESS_HINT[r]) + '</span></span>' +
              (locked ? '<span class="ms-tag">' + t('lockedTag') + '</span>'
                      : isPrimary ? '<span class="ms-tag">' + t('primaryAccess') + '</span>' : '') +
            '</label>';
          }).join('') +
          '<div class="ms-foot">' +
            '<button type="button" class="ghost-btn ms-reset">' + t('msReset') + '</button>' +
            '<button type="button" class="ghost-btn ms-all">' + t('msSelectAll') + '</button>' +
          '</div>' +
        '</div></div>';
    }

    // Saving is deferred to menu-close: checking three boxes should be one
    // save, not three round-trips with three toasts.
    function wireAccessPickers(root) {
      root.querySelectorAll('.ms').forEach(function (ms) {
        var trigger = ms.querySelector('.ms-trigger');
        var menu = ms.querySelector('.ms-menu');
        var boxes = Array.prototype.slice.call(ms.querySelectorAll('.ms-opt input'));
        var id = ms.getAttribute('data-user');
        var before = boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; });

        function sync() {
          boxes.forEach(function (b) {
            var opt = b.closest('.ms-opt');
            opt.classList.toggle('on', b.checked);
            opt.setAttribute('aria-selected', String(b.checked));
          });
        }
        // The menu lives inside .tbl-wrap, which scrolls — an absolutely
        // positioned dropdown gets sliced off by that overflow. Fixed
        // positioning escapes it; the coordinates are recomputed here and
        // on scroll/resize, and the menu flips above the trigger when
        // there isn't room below (the last row in the table).
        function place() {
          var r = trigger.getBoundingClientRect();
          var h = menu.offsetHeight || 220;
          var below = window.innerHeight - r.bottom;
          var flip = below < h + 12 && r.top > h + 12;
          menu.style.top = (flip ? r.top - h - 5 : r.bottom + 5) + 'px';
          var w = menu.offsetWidth || 268;
          var left = isAr() ? r.right - w : r.left;
          menu.style.left = Math.max(8, Math.min(left, window.innerWidth - w - 8)) + 'px';
        }
        function closeMenu() {
          if (menu.hidden) return;
          menu.hidden = true;
          trigger.setAttribute('aria-expanded', 'false');
          window.removeEventListener('scroll', place, true);
          window.removeEventListener('resize', place);
          if (openAccessPicker === closeMenu) openAccessPicker = null;
          commit();
        }
        function commit() {
          var now = boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
          if (now.join() === before.join()) return;
          var u = usersAll().find(function (x) { return x.id === id; });
          // A user with no access at all could never sign in; keep the
          // primary rather than saving something unusable.
          if (!now.length) { render(); return; }
          // Primary decides the landing view: keep the existing one when
          // it survives, otherwise fall back to the most privileged left.
          var primary = now.indexOf(u && u.role) >= 0 ? u.role
            : (['mgr', 'fin', 'emp'].filter(function (r) { return now.indexOf(r) >= 0; })[0]);
          var patch = { role: primary, accesses: now };
          if (window.LIVE) {
            SH_API.patchUser(id, patch).then(function () {
              toast(t('accessUpdated')); render();
            }).catch(function (e2) { toast(String(e2.message)); render(); });
            return;
          }
          saveOverride(id, patch);
          audit('Set access of ' + (u ? u.name : id) + ' to ' + now.map(roleName).join(', '));
          toast(t('accessUpdated'));
          render();
        }

        trigger.addEventListener('click', function (e) {
          e.stopPropagation();
          // Only one picker open at a time. If a DIFFERENT one is open,
          // close (and commit) it first and stop there — a commit that
          // actually changed something calls render(), which replaces
          // content.innerHTML and detaches this very trigger/menu, so
          // touching them afterward in the same handler would act on
          // stale nodes. The user's click still registers as closing the
          // other picker; opening this one takes one more click, same as
          // clicking anywhere else to dismiss it.
          if (openAccessPicker && openAccessPicker !== closeMenu) { openAccessPicker(); return; }
          var open = menu.hidden;
          menu.hidden = !open;
          trigger.setAttribute('aria-expanded', String(open));
          if (open) {
            openAccessPicker = closeMenu;
            place();
            window.addEventListener('scroll', place, true);
            window.addEventListener('resize', place);
          } else {
            openAccessPicker = null;
            window.removeEventListener('scroll', place, true);
            window.removeEventListener('resize', place);
            commit();
          }
        });
        menu.addEventListener('click', function (e) { e.stopPropagation(); });
        boxes.forEach(function (b) { b.addEventListener('change', sync); });
        ms.querySelector('.ms-reset').addEventListener('click', function () {
          var primary = (usersAll().find(function (x) { return x.id === id; }) || {}).role;
          boxes.forEach(function (b) { if (!b.disabled) b.checked = b.value === primary; });
          sync();
        });
        ms.querySelector('.ms-all').addEventListener('click', function () {
          boxes.forEach(function (b) { if (!b.disabled) b.checked = true; });
          sync();
        });
        ms.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeMenu(); trigger.focus(); } });
      });
    }

    function render(focusSearch) {
      var all = usersAll();
      var q = query.trim().toLowerCase();
      var filtered = q ? all.filter(function (u) {
        return (u.name + ' ' + (u.email || '') + ' ' + (u.dept || '')).toLowerCase().indexOf(q) >= 0;
      }) : all;
      var totalPages = Math.max(1, Math.ceil(filtered.length / PER));
      if (page > totalPages) page = totalPages;
      var pageUsers = filtered.slice((page - 1) * PER, page * PER);

      var rows = pageUsers.map(function (u) {
        var isSelf = u.id === user.id;
        return '<tr>' +
          '<td><div class="u-cell">' + avatarHtml(u, 'u-av') + '' +
            '<div class="u-meta"><b>' + esc(u.name) + (isSelf ? ' · ' + t('you') : '') + '</b>' +
            '<span class="cell-sub">' + esc(u.email || '—') + '</span></div></div></td>' +
          '<td>' + (u.active
            ? '<span class="dot-badge active"><i></i>' + t('active') + '</span>'
            : '<span class="dot-badge off"><i></i>' + t('disabled') + '</span>') + '</td>' +
          '<td>' + esc(trDept(u.dept) || '—') + '</td>' +
          '<td><div class="access-cell">' +
            accessPicker(u, isSelf) +
          '</div></td>' +
          '<td style="white-space:nowrap; text-align:end">' +
            '<button class="tbl-icon edit-user" data-user="' + esc(u.id) + '" title="' + t('editBtn') + '" aria-label="' + t('editBtn') + '">' + ICONS.pencil + '</button>' +
            (isSelf ? '' : '<button class="tbl-icon toggle-active" data-user="' + esc(u.id) + '" title="' + (u.active ? t('disable') : t('enable')) + '" aria-label="' + (u.active ? t('disable') : t('enable')) + '">' + (u.active ? ICONS.ban : ICONS.check) + '</button>') +
          '</td>' +
        '</tr>';
      }).join('');

      content.innerHTML =
        '<div class="filter-row">' +
          '<div style="display:flex; align-items:center; gap:10px"><h2>' + t('teamTitle') + '</h2>' +
            '<span class="count-badge">' + t('usersCount', { n: all.length }) + '</span></div>' +
          '<div class="spacer"></div>' +
          '<input type="search" id="tbl-search" class="tbl-search" placeholder="' + t('searchUsers') + '" value="' + esc(query) + '">' +
          '<button class="btn" id="add-user-btn">' + t('addUser') + '</button>' +
        '</div>' +
        '<div id="au-overlay" hidden>' +
          '<div class="drawer-backdrop" id="au-backdrop"></div>' +
          '<div class="drawer au-drawer" role="dialog" aria-modal="true">' +
            '<div class="d-head"><h3 id="au-title">' + t('addUserTitle') + '</h3>' +
              '<button class="icon-btn" id="au-close" aria-label="' + t('cancel') + '">✕</button></div>' +
            '<form id="add-user-form" style="margin-top:14px">' +
              '<div class="au-fields">' +
                '<div><label class="f-label" for="nu-name">' + t('fullName') + '</label><input type="text" id="nu-name" required></div>' +
                '<div><label class="f-label" for="nu-email">' + t('emailReq') + '</label><input type="email" id="nu-email" required placeholder="name@zid.sa"></div>' +
                '<div><label class="f-label" for="nu-dept">' + t('deptLbl') + '</label><input type="text" id="nu-dept"></div>' +
                '<div><label class="f-label" for="nu-title">' + t('jobTitle') + '</label><input type="text" id="nu-title"></div>' +
                '<div id="nu-role-group"><label class="f-label" for="nu-role">' + t('role') + '</label><select id="nu-role">' +
                  '<option value="emp">' + t('roleHunter') + '</option><option value="mgr">' + t('roleMgmt') + '</option><option value="fin">' + t('roleFin') + '</option>' +
                '</select><p class="f-hint">' + t('ssoHint') + '</p></div>' +
              '</div>' +
              '<div class="au-actions">' +
                '<button type="button" class="btn secondary" id="add-user-cancel">' + t('cancel') + '</button>' +
                '<button type="submit" class="btn" id="au-submit">' + t('createUser') + '</button>' +
              '</div>' +
            '</form>' +
          '</div>' +
        '</div>' +
        '<section class="card">' +
          '<div class="tbl-wrap"><table>' +
            '<thead><tr><th>' + t('user') + '</th><th>' + t('status') + '</th><th>' + t('department') + '</th><th>' + t('accessCol') + '</th><th></th></tr></thead>' +
            '<tbody>' + (rows || '<tr><td colspan="5"><div class="empty">' + t('noneFound') + '</div></td></tr>') + '</tbody>' +
          '</table></div>' +
          '<div class="pager">' +
            '<span class="sub">' + t('pageOf', { p: page, n: totalPages }) + '</span>' +
            '<div style="display:flex; gap:8px">' +
              '<button class="btn secondary" id="pg-prev"' + (page <= 1 ? ' disabled' : '') + '>' + t('prev') + '</button>' +
              '<button class="btn secondary" id="pg-next"' + (page >= totalPages ? ' disabled' : '') + '>' + t('next') + '</button>' +
            '</div>' +
          '</div>' +
        '</section>' +
        '<p class="sub" style="text-align:center">' + t('teamNote') + '</p>';

      var searchEl = document.getElementById('tbl-search');
      searchEl.addEventListener('input', function () { query = this.value; page = 1; render(true); });
      if (focusSearch) { searchEl.focus(); searchEl.setSelectionRange(searchEl.value.length, searchEl.value.length); }
      document.getElementById('pg-prev').addEventListener('click', function () { if (page > 1) { page--; render(); } });
      document.getElementById('pg-next').addEventListener('click', function () { if (page < totalPages) { page++; render(); } });

      function openForm(u) {
        editingId = u ? u.id : null;
        document.getElementById('au-title').textContent = u ? t('editUserTitle', { name: u.name }) : t('addUserTitle');
        document.getElementById('au-submit').textContent = u ? t('saveChanges') : t('createUser');
        document.getElementById('nu-name').value = u ? u.name : '';
        document.getElementById('nu-email').value = u ? u.email : '';
        document.getElementById('nu-email').disabled = !!u;
        document.getElementById('nu-dept').value = u ? u.dept : '';
        document.getElementById('nu-title').value = u ? u.title : '';
        document.getElementById('nu-role').value = u ? u.role : 'emp';
        // Role is only chosen at creation; accesses are edited inline in
        // the table with the access picker.
        document.getElementById('nu-role-group').hidden = !!u;
        document.getElementById('au-overlay').hidden = false;
        if (auRelease) auRelease();
        auRelease = trapOverlay(document.querySelector('.au-drawer'), closeForm);
        document.getElementById('nu-name').focus();
      }
      var auRelease = null;
      function closeForm() {
        if (auRelease) { auRelease(); auRelease = null; }
        document.getElementById('au-overlay').hidden = true;
        editingId = null;
      }
      document.getElementById('add-user-btn').addEventListener('click', function () { openForm(null); });
      document.getElementById('add-user-cancel').addEventListener('click', closeForm);
      document.getElementById('au-close').addEventListener('click', closeForm);
      document.getElementById('au-backdrop').addEventListener('click', closeForm);
      document.getElementById('add-user-form').addEventListener('submit', function (e) {
        e.preventDefault();
        var name = document.getElementById('nu-name').value.trim();
        var email = document.getElementById('nu-email').value.trim();
        if (!name || !email) return;
        var nuRole = document.getElementById('nu-role').value;
        var nu = {
          name: name, email: email,
          dept: document.getElementById('nu-dept').value.trim() || 'General',
          title: document.getElementById('nu-title').value.trim() || roleName(nuRole),
          role: nuRole
        };
        if (editingId) {
          // role + extra access are edited inline, not in the form
          var patch = { name: nu.name, dept: nu.dept, title: nu.title };
          if (window.LIVE) {
            SH_API.patchUser(editingId, patch).then(function () {
              toast(t('userSavedToast', { name: name })); editingId = null; closeForm(); render();
            }).catch(function (e2) { toast(String(e2.message)); });
            return;
          }
          saveOverride(editingId, patch);
          audit('Edited user ' + name);
          toast(t('userSavedToast', { name: name }));
          editingId = null; closeForm(); render();
          return;
        }
        if (window.LIVE) {
          SH_API.addUser(nu).then(function () {
            toast(t('userAddedToast', { name: name })); closeForm(); render();
          }).catch(function (e2) { toast(String(e2.message)); });
          return;
        }
        var custom = LS.get('users', []);
        custom.push(Object.assign({ id: 'u' + (100 + custom.length), code: String(8681849300 + custom.length) }, nu));
        LS.set('users', custom);
        audit('Added user ' + name + ' (' + roleName(nuRole) + ')');
        toast(t('userAddedToast', { name: name }));
        closeForm(); render();
      });
      content.querySelectorAll('.edit-user').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var u = usersAll().find(function (x) { return x.id === btn.getAttribute('data-user'); });
          if (u) openForm(u);
        });
      });
      wireAccessPickers(content);
      content.querySelectorAll('.toggle-active').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-user');
          var u = usersAll().find(function (x) { return x.id === id; });
          if (window.LIVE) {
            SH_API.patchUser(id, { active: !u.active }).then(function () {
              toast(t(u.active ? 'userDisabled' : 'userEnabled', { name: u.name })); render();
            }).catch(function (e2) { toast(String(e2.message)); render(); });
            return;
          }
          saveOverride(id, { active: !u.active });
          audit((u.active ? 'Disabled ' : 'Enabled ') + u.name);
          toast(t(u.active ? 'userDisabled' : 'userEnabled', { name: u.name }));
          render();
        });
      });
    }
    render();
  }

  /* ---- Management backoffice: program settings + audit log ---- */
  /* ---- Management: self-service integrations (HubSpot / Metabase) ---- */
  /* Every pipeline in the connected HubSpot portal (id + real name),
     pulled live from the account. Nothing here is pre-selected for
     you — pick whichever pipelines your deals actually live in. */
  var HS_ALL_PIPELINES = [
    { id: '4104812', label: 'Enterprise Pipeline' }, { id: '12664947', label: "NGO's Pipeline" },
    { id: '20116133', label: 'ZidPOS Pipeline' }, { id: '77452599', label: 'Pre-Sales 2025' },
    { id: '891587615', label: 'SDR - Whatsapp Qualification' }, { id: '897552273', label: 'Pre-Sales' },
    { id: '78432319', label: 'Growth Pipeline' }, { id: '113684560', label: 'Enterprise Pipeline Revamp' },
    { id: '26669937', label: 'PLG' }, { id: '653632624', label: 'ZidHub  Deals Pipeline' },
    { id: '672915820', label: 'Financing' }, { id: '686408229', label: 'MR Mazeed Packages' },
    { id: '39948135', label: 'Sales Pipeline' }, { id: '686111358', label: 'Mazeed Package Pipeline' },
    { id: '820236450', label: 'GCC- Oman' }, { id: '820236454', label: 'GCC- Kuwait' },
    { id: '831963487', label: 'GCC - UAE' }, { id: '833718609', label: 'Zammit' },
    { id: '888536756', label: 'GCC' }, { id: '894816055', label: 'Western Region' },
    { id: '895151464', label: 'Syria Pipeline' }, { id: '39707223', label: 'Nurturing' },
    { id: '699701572', label: 'ZAD(NGO) Pipeline' }, { id: '705217563', label: 'Up/Cross-selling' },
    { id: '44886956', label: 'Sales Ops Data' }, { id: '726721931', label: 'DEALS TEST' },
    { id: '45594763', label: 'Potential Spam Deals' }, { id: '748832880', label: 'POS 2025 Deals' },
    { id: '47634448', label: 'D50' }, { id: '753706630', label: 'Wanted Stores - Pipeline' },
    { id: '49585481', label: 'Sales Affiliate Pipeline' }, { id: '52441191', label: 'Renewals (Temporary)' },
    { id: '779938187', label: 'Growth Services 2025' }, { id: '813044005', label: 'Samara Event Deals' },
    { id: '53471929', label: 'Renewal / Cross Selling' }, { id: '59564674', label: 'Special Projects' },
    { id: '60753172', label: 'External Data - Western Region' }, { id: '62384003', label: 'External Data (Marketing leads)' },
    { id: '65306130', label: 'ZidPos - Resellers' }, { id: '836000575', label: 'Rising Stars - High Touch Deals' },
    { id: '65412645', label: 'Archive' }, { id: '876728344', label: 'Elite Pipeline' },
    { id: '894137123', label: 'Zammit Sales Renewal' }, { id: '894137124', label: 'Zammit Renewal' },
    { id: '907190433', label: 'PLG 2026' }, { id: '920783183', label: 'WinBack' }
  ];

  /* Small reusable chip/tag input: add via Enter or comma, remove via ×
     on the chip. Value is a comma-joined string in a hidden input so
     it participates in normal form submission. */
  function chipInput(id, values, placeholder) {
    var chips = (values || []).filter(Boolean);
    return '<div class="chip-input" id="' + id + '-wrap">' +
        '<div class="chip-list" id="' + id + '-list">' +
          chips.map(function (v) { return chipHtml(v); }).join('') +
        '</div>' +
        '<input type="text" id="' + id + '-add" placeholder="' + esc(placeholder || '') + '">' +
        '<input type="hidden" id="' + id + '" value="' + esc(chips.join(',')) + '">' +
      '</div>';
  }
  function chipHtml(v) {
    return '<span class="chip">' + esc(v) + '<button type="button" class="chip-x" data-v="' + esc(v) + '" aria-label="Remove">×</button></span>';
  }
  function wireChipInput(id) {
    var wrap = document.getElementById(id + '-wrap');
    if (!wrap) return;
    var list = document.getElementById(id + '-list');
    var add = document.getElementById(id + '-add');
    var hidden = document.getElementById(id);
    function current() { return hidden.value ? hidden.value.split(',') : []; }
    function sync(vals) { hidden.value = vals.join(','); }
    function addChip(v) {
      v = v.trim();
      if (!v) return;
      var vals = current();
      if (vals.indexOf(v) >= 0) return;
      vals.push(v);
      sync(vals);
      list.insertAdjacentHTML('beforeend', chipHtml(v));
    }
    add.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        addChip(add.value.replace(/,$/, ''));
        add.value = '';
      } else if (e.key === 'Backspace' && !add.value) {
        var vals = current();
        if (vals.length) { vals.pop(); sync(vals); list.lastElementChild && list.lastElementChild.remove(); }
      }
    });
    add.addEventListener('blur', function () { if (add.value.trim()) { addChip(add.value); add.value = ''; } });
    list.addEventListener('click', function (e) {
      var btn = e.target.closest('.chip-x');
      if (!btn) return;
      var vals = current().filter(function (v) { return v !== btn.getAttribute('data-v'); });
      sync(vals);
      btn.closest('.chip').remove();
    });
  }

  function viewIntegrations(content) {
    var cfg = {}; // name -> row

    function statusPill(row) {
      if (!row) return '<span class="dot-badge off"><i></i>' + t('intgNotConfigured') + '</span>';
      if (row.last_status && /error|fail/i.test(row.last_status)) return '<span class="dot-badge off" style="color:var(--critical)"><i style="background:var(--critical)"></i>' + t('intgError') + '</span>';
      if (row.secret_set) return '<span class="dot-badge active"><i></i>' + t('intgConnected') + '</span>';
      return '<span class="dot-badge off"><i></i>' + t('intgNotConfigured') + '</span>';
    }
    function lastSync(row) {
      return row && row.last_synced_at ? t('intgLastSync', { when: fmtDate(new Date(row.last_synced_at)) }) : t('intgNeverSynced');
    }
    function fieldRow(id, label, val, ph, type, hint) {
      return '<div><label class="f-label" for="' + id + '">' + esc(label) + '</label>' +
        '<input type="' + (type || 'text') + '" id="' + id + '" value="' + esc(val || '') + '" placeholder="' + esc(ph || '') + '">' +
        (hint ? '<p class="f-hint">' + esc(hint) + '</p>' : '') + '</div>';
    }

    function render() {
      var hs = cfg.hubspot, mb = cfg.metabase;
      var hsS = (hs && hs.settings) || {}, mbS = (mb && mb.settings) || {};
      // Nothing pre-selected — an unconfigured integration starts empty
      // and you choose every pipeline and property yourself.
      var selectedPipelines = hsS.pipelines || [];
      var extraProps = hsS.extra_properties || [];
      var pipelineQuery = '';

      function pipelineListHtml(q) {
        q = (q || '').trim().toLowerCase();
        var items = HS_ALL_PIPELINES.filter(function (p) {
          return !q || p.label.toLowerCase().indexOf(q) >= 0 || p.id.indexOf(q) >= 0;
        });
        if (!items.length) return '<p class="f-hint" style="padding:10px">' + t('intgNoPipelineMatch') + '</p>';
        return items.map(function (p) {
          var checked = selectedPipelines.indexOf(p.id) >= 0;
          return '<label class="pipeline-chk"><input type="checkbox" class="hs-pipeline-cb" value="' + p.id + '"' + (checked ? ' checked' : '') + '>' +
            '<span>' + esc(p.label) + '</span><span class="cell-sub">' + p.id + '</span></label>';
        }).join('');
      }

      content.innerHTML =
        '<div class="filter-row"><div><h2>' + t('navIntegrations') + '</h2>' +
          '<p class="sub">' + t('intgSub') + '</p></div></div>' +

        '<section class="card intg-card">' +
          '<div class="intg-head"><div class="intg-title"><span class="intg-logo hs">H</span>' +
            '<div><h3>HubSpot</h3><p class="sub">' + t('intgHubspotSub') + '</p></div></div>' + statusPill(hs) + '</div>' +
          '<form id="hs-form" class="intg-body">' +
            '<h4 class="intg-sub-h">' + t('intgSecAuth') + '</h4>' +
            '<div class="form-grid">' +
              fieldRow('hs-token', t('intgToken'), '', hs && hs.secret_set ? t('intgSecretSaved', { hint: hsS.secret_hint || '••••' }) : 'pat-…', 'password',
                t('intgTokenHint')) +
            '</div>' +

            '<h4 class="intg-sub-h">' + t('intgSecPipelines') + '</h4>' +
            '<p class="f-hint" style="margin-bottom:8px">' + t('intgPipelinesHint') + '</p>' +
            '<input type="search" id="hs-pipeline-search" class="tbl-search" style="width:100%; margin-bottom:8px" placeholder="' + t('intgPipelineSearchPh') + '">' +
            '<div class="pipeline-grid" id="hs-pipeline-list">' + pipelineListHtml('') + '</div>' +
            '<p class="f-hint" id="hs-pipeline-count" style="margin-top:6px">' + t('intgPipelinesSelected', { n: selectedPipelines.length }) + '</p>' +

            '<h4 class="intg-sub-h">' + t('intgSecFields') + '</h4>' +
            '<p class="f-hint" style="margin-bottom:8px">' + t('intgFieldsHint') + '</p>' +
            '<div class="form-grid">' +
              fieldRow('hs-target', t('intgTargetType'), hsS.target_type || '', 'Sales Hunter', 'text', t('intgTargetTypeHint')) +
              fieldRow('hs-prop', t('intgHunterProp'), hsS.hunter_prop || '', 'lead_by__zidder_email_') +
              fieldRow('hs-amount', t('intgAmountProp'), hsS.amount_prop || '', 'amount_without_vat') +
              fieldRow('hs-close', t('intgCloseProp'), hsS.close_date_prop || '', 'closedate') +
              fieldRow('hs-lost', t('intgLostProp'), hsS.lost_reason_prop || '', 'closed_lost_reasons') +
              fieldRow('hs-unqual', t('intgUnqualProp'), hsS.unqualified_reason_prop || '', 'unqualified_reason__asbab_dm_altahl') +
            '</div>' +

            '<div style="margin-top:14px"><label class="f-label" for="hs-extra-props">' + t('intgExtraProps') + '</label>' +
              chipInput('hs-extra-props', extraProps, t('intgExtraPropsPh')) +
              '<p class="f-hint">' + t('intgExtraPropsHint') + '</p></div>' +

            '<div class="intg-actions"><span class="sub">' + lastSync(hs) + '</span>' +
              '<button type="submit" class="btn">' + t('saveChanges') + '</button></div>' +
          '</form>' +
        '</section>' +

        '<section class="card intg-card">' +
          '<div class="intg-head"><div class="intg-title"><span class="intg-logo mb">M</span>' +
            '<div><h3>Metabase</h3><p class="sub">' + t('intgMetabaseSub') + '</p></div></div>' + statusPill(mb) + '</div>' +
          '<form id="mb-form" class="intg-body">' +
            '<div class="form-grid">' +
              fieldRow('mb-url', t('intgMbUrl'), mbS.base_url || '', 'https://metabase.your-co.com') +
              fieldRow('mb-key', t('intgMbKey'), '', mb && mb.secret_set ? t('intgSecretSaved', { hint: mbS.secret_hint || '••••' }) : 'mb_…', 'password') +
              fieldRow('mb-comm', t('intgCardComm'), mbS.card_commissions || '', 'e.g. 142') +
              fieldRow('mb-subs', t('intgCardSubs'), mbS.card_subscriptions || '', 'e.g. 143') +
            '</div>' +
            // No top-stores card ID: the showcase is ranked from the
            // warehouse table by the sync itself. It used to point at a
            // saved question, whose own filters quietly cut it down to a
            // single store — a knob that could break the page from
            // outside the app is worse than no knob.
            '<p class="f-hint">' + t('intgStoresAuto') + '</p>' +
            '<div class="intg-actions"><span class="sub">' + lastSync(mb) + '</span>' +
              '<button type="submit" class="btn">' + t('saveChanges') + '</button></div>' +
          '</form>' +
        '</section>' +
        '<p class="sub" style="text-align:center">' + t('intgSecurityNote') + '</p>';

      wireChipInput('hs-extra-props');

      // Selection survives search filtering (re-rendering the list on
      // every keystroke would otherwise drop unchecked-off-screen picks).
      var selectedSet = {};
      selectedPipelines.forEach(function (id) { selectedSet[id] = true; });
      var pipelineList = document.getElementById('hs-pipeline-list');
      var pipelineCount = document.getElementById('hs-pipeline-count');
      function refreshCount() {
        pipelineCount.textContent = t('intgPipelinesSelected', { n: Object.keys(selectedSet).filter(function (k) { return selectedSet[k]; }).length });
      }
      pipelineList.addEventListener('change', function (e) {
        if (!e.target.classList.contains('hs-pipeline-cb')) return;
        selectedSet[e.target.value] = e.target.checked;
        refreshCount();
      });
      document.getElementById('hs-pipeline-search').addEventListener('input', function () {
        var q = this.value;
        pipelineList.innerHTML = HS_ALL_PIPELINES.filter(function (p) {
          var ql = q.trim().toLowerCase();
          return !ql || p.label.toLowerCase().indexOf(ql) >= 0 || p.id.indexOf(ql) >= 0;
        }).map(function (p) {
          return '<label class="pipeline-chk"><input type="checkbox" class="hs-pipeline-cb" value="' + p.id + '"' + (selectedSet[p.id] ? ' checked' : '') + '>' +
            '<span>' + esc(p.label) + '</span><span class="cell-sub">' + p.id + '</span></label>';
        }).join('') || '<p class="f-hint" style="padding:10px">' + t('intgNoPipelineMatch') + '</p>';
      });

      document.getElementById('hs-form').addEventListener('submit', function (e) {
        e.preventDefault();
        var picked = Object.keys(selectedSet).filter(function (k) { return selectedSet[k]; });
        save('hubspot', {
          pipelines: picked,
          hunter_prop: document.getElementById('hs-prop').value.trim(),
          target_type: document.getElementById('hs-target').value.trim(),
          amount_prop: document.getElementById('hs-amount').value.trim(),
          close_date_prop: document.getElementById('hs-close').value.trim(),
          lost_reason_prop: document.getElementById('hs-lost').value.trim(),
          unqualified_reason_prop: document.getElementById('hs-unqual').value.trim(),
          extra_properties: (document.getElementById('hs-extra-props').value || '').split(',').filter(Boolean)
        }, document.getElementById('hs-token').value);
      });
      document.getElementById('mb-form').addEventListener('submit', function (e) {
        e.preventDefault();
        save('metabase', {
          base_url: document.getElementById('mb-url').value.trim(),
          card_commissions: document.getElementById('mb-comm').value.trim(),
          card_subscriptions: document.getElementById('mb-subs').value.trim()
        }, document.getElementById('mb-key').value);
      });
    }

    function save(name, settings, secret) {
      if (!window.LIVE) {
        toast(t('intgDemoNote'));
        return;
      }
      SH_API.saveIntegration(name, settings, secret.trim() || null).then(function () {
        toast(t('intgSaved'));
        return load();
      }).catch(function (e2) { toast(String(e2.message)); });
    }
    function load() {
      if (!window.LIVE) { render(); return Promise.resolve(); }
      return SH_API.getIntegrations().then(function (rows) {
        cfg = {};
        (rows || []).forEach(function (r) { cfg[r.name] = r; });
        render();
      });
    }
    load();
  }

  function viewSettings(content) {
    var log = LS.get('audit', []);
    content.innerHTML =
      '<div class="grid-2">' +
        '<section class="card">' +
          '<div class="card-head"><div><h3>' + t('commissionRules') + '</h3>' +
          '<p class="sub">' + t('rulesSub') + '</p></div></div>' +
          '<form id="settings-form"><div class="form-grid">' +
            '<div><label class="f-label" for="set-rate">' + t('commissionPctLbl') + '</label>' +
              // Trim float noise: 0.07*100 is 7.000000000000001, which
              // fails the input's own step="0.5" and blocks the NEXT save
              // with a validation bubble on a number nobody typed.
              '<input type="number" id="set-rate" min="1" max="50" step="0.5" value="' + +(COMMISSION_RATE * 100).toFixed(2) + '">' +
              '<p class="f-hint">' + t('currentRate', { rate: ratePct() }) + '</p></div>' +
            '<div><label class="f-label" for="set-vat">' + t('vatLbl') + '</label>' +
              '<input type="number" id="set-vat" min="0" max="30" step="1" value="' + +(VAT_RATE * 100).toFixed(2) + '">' +
              '<p class="f-hint">' + t('vatHint') + '</p></div>' +
          '</div>' +
          '<div style="margin-top:14px"><button type="submit" class="btn">' + t('saveRules') + '</button></div></form>' +
          (window.LIVE ? '<div style="margin-top:18px; padding-top:16px; border-top:1px solid var(--hairline)">' +
            '<label class="f-label" for="set-refresh">' + t('autoRefreshLbl') + '</label>' +
            '<select id="set-refresh" style="max-width:220px">' +
              [[1, t('everyMin', { n: 1 })], [2, t('everyMins', { n: 2 })], [5, t('everyMins', { n: 5 })],
               [10, t('everyMins', { n: 10 })], [0, t('refreshOff')]].map(function (o) {
                return '<option value="' + o[0] + '"' + (o[0] === refreshMins() ? ' selected' : '') + '>' + o[1] + '</option>';
              }).join('') + '</select>' +
            '<p class="f-hint">' + t('autoRefreshHint') + '</p></div>' : '') +
        '</section>' +
        (window.LIVE ? '' :
        '<section class="card">' +
          '<div class="card-head"><div><h3>' + t('demoControls') + '</h3><p class="sub">' + t('forPresentations') + '</p></div></div>' +
          '<p class="sub" style="margin-bottom:12px">' + t('resetSub') + '</p>' +
          '<button class="btn secondary" id="reset-demo">' + t('resetBtn') + '</button>' +
        '</section>') +
      '</div>' +
      '<section class="card">' +
        '<div class="card-head"><div><h3>' + t('auditLog') + '</h3><p class="sub">' + t('auditSub') + '</p></div></div>' +
        (log.length
          ? '<div class="tbl-wrap"><table class="mini"><thead><tr><th>' + t('when') + '</th><th>' + t('who') + '</th><th>' + t('action') + '</th></tr></thead><tbody>' +
            log.map(function (e) {
              return '<tr><td>' + fmtDate(new Date(e.at)) + '<span class="cell-sub">' + new Date(e.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + '</span></td>' +
                '<td>' + esc(e.who) + '</td><td>' + esc(e.action) + '</td></tr>';
            }).join('') + '</tbody></table></div>'
          : '<div class="empty">' + t('auditEmpty') + '</div>') +
      '</section>' +
      (window.LIVE ? '<section class="card" id="health-card">' +
        '<div class="card-head"><div><h3>' + t('sysHealth') + '</h3><p class="sub">' + t('sysHealthSub') + '</p></div></div>' +
        '<div id="health-body"><div class="empty">' + t('loadingLive') + '</div></div>' +
      '</section>' : '');

    var setRefresh = document.getElementById('set-refresh');
    if (setRefresh) setRefresh.addEventListener('change', function () {
      LS.set('refreshMins', parseInt(this.value, 10));
      toast(t('rulesSavedShort'));
    });

    if (window.LIVE) {
      SH_API.recentErrors().then(function (rows) {
        var body = document.getElementById('health-body');
        if (!body) return;
        body.innerHTML = (rows && rows.length)
          ? '<div class="tbl-wrap"><table class="mini"><thead><tr><th>' + t('when') + '</th><th>' + t('who') + '</th><th>' + t('errorCol') + '</th></tr></thead><tbody>' +
            rows.map(function (r) {
              return '<tr><td style="white-space:nowrap">' + fmtDate(new Date(r.created_at)) +
                '<span class="cell-sub">' + new Date(r.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + '</span></td>' +
                '<td>' + esc(r.actor_email || '—') + '</td>' +
                '<td>' + esc(r.message) + '<span class="cell-sub">' + esc([r.context, r.page].filter(Boolean).join(' · ')) + '</span></td></tr>';
            }).join('') + '</tbody></table></div>'
          : '<div class="empty">' + t('sysHealthOk') + '</div>';
      });
    }

    document.getElementById('settings-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var rate = parseFloat(document.getElementById('set-rate').value);
      var vat = parseFloat(document.getElementById('set-vat').value);
      if (isNaN(rate) || rate <= 0 || rate > 50 || isNaN(vat) || vat < 0 || vat > 30) {
        toast(t('rulesRange'));
        return;
      }
      if (window.LIVE) {
        SH_API.saveSettings(rate / 100, vat / 100).then(function () {
          COMMISSION_RATE = rate / 100; VAT_RATE = vat / 100;
          toast(t('rulesSaved', { rate: ratePct() })); route();
        }).catch(function (e2) { toast(String(e2.message)); });
        return;
      }
      COMMISSION_RATE = rate / 100;
      VAT_RATE = vat / 100;
      LS.set('settings', { commissionRate: COMMISSION_RATE, vatRate: VAT_RATE });
      audit('Set commission to ' + rate + '% and VAT to ' + vat + '%');
      toast(t('rulesSaved', { rate: ratePct() }));
      route();
    });
    var resetBtn = document.getElementById('reset-demo');
    if (resetBtn) resetBtn.addEventListener('click', function () {
      ['leads', 'paystatus', 'payslips', 'users', 'userOverrides', 'settings', 'audit'].forEach(function (k) {
        try { localStorage.removeItem('sh.' + k); } catch (e) {}
      });
      EMPLOYEES.forEach(function (emp) { try { localStorage.removeItem('sh.profile.' + emp.id); } catch (e) {} });
      Object.keys(COMMISSION_STATUS_OVERRIDES).forEach(function (k) { delete COMMISSION_STATUS_OVERRIDES[k]; });
      COMMISSION_RATE = 0.20; VAT_RATE = 0.15;
      toast(t('resetToast'));
      route();
    });
  }

  /* ---- Top Zid stores: categories first, drill into each ---- */
  function viewTopStores(content, user) {
    /* Live mode reads the store_showcase table (Metabase-fed); the
       bundled mock list is demo-only. */
    var showcase = window.LIVE ? (LIVE.showcase || []) : STORE_SHOWCASE;
    // Order volume/revenue are for management & finance only. RLS already
    // keeps a real hunter session from ever receiving them, but a
    // dual-role person previewing via the Management/Hunter toggle still
    // has their real (management) data loaded client-side — gate the
    // rendering on the currently *acting* role too, not just what RLS let
    // through at fetch time.
    var canSeeVolume = roleOf() === 'mgr' || roleOf() === 'fin';
    var myLeads = isManager() ? [] : leadsOf(user.id);
    var mineByCat = {};
    myLeads.forEach(function (l) { mineByCat[l.industry] = (mineByCat[l.industry] || 0) + 1; });

    // program-wide win rate per category, as a hunting hint
    var all = allLeads();
    var catWin = {};
    all.forEach(function (l) {
      var cd = closedDate(l);
      if (!cd) return;
      if (!catWin[l.industry]) catWin[l.industry] = { decided: 0, won: 0 };
      catWin[l.industry].decided += 1;
      if (l.stage === 'won') catWin[l.industry].won += 1;
    });
    function winRateOf(cat) {
      return catWin[cat] && catWin[cat].decided >= 3 ? catWin[cat].won / catWin[cat].decided : null;
    }

    function renderCategories() {
      var header =
        '<div class="card" style="display:flex; justify-content:space-between; gap:14px; flex-wrap:wrap; align-items:center">' +
          '<div><h2>' + t('storesTitle') + '</h2>' +
          '<p class="sub">' + t('storesSub') + '</p></div>' +
        '</div>';
      if (!showcase.length) {
        content.innerHTML = header +
          '<div class="card" style="text-align:center; padding:44px 24px">' +
            '<h3>' + t('storesEmpty') + '</h3>' +
            '<p class="sub" style="margin-top:6px">' + t('storesEmptySub') + '</p>' +
          '</div>';
        return;
      }
      content.innerHTML = header +
        '<div class="store-grid">' +
        showcase.map(function (c, i) {
          var wr = winRateOf(c.category);
          var mine = mineByCat[c.category] || 0;
          var leader = c.stores[0];
          return '<button class="card store-card cat-card" data-cat="' + i + '">' +
            '<div class="s-cat"><span class="cat-chip">' + esc(trCat(c.category)) + '</span>' +
            (wr !== null ? '<span class="s-meta">' + t('catWinRate', { pct: fmtPct(wr, 0) }) + '</span>' : '') + '</div>' +
            '<div><h3>' + t('no1', { name: esc(leader.name) }) + '</h3>' +
              (canSeeVolume && leader.ordersCount != null ? '<span class="s-meta">' + fmtNum(leader.ordersCount) + ' ' + t('ordersAllTime') + '</span>' : '') + '</div>' +
            '<p class="s-blurb">' + t(c.stores.length === 1 ? 'topStoreCount' : 'topStoresCount', { n: c.stores.length }) +
              (mine ? ' · <span class="s-mine">' + t(mine === 1 ? 'youHaveLead' : 'youHaveLeads', { n: mine }) + '</span>' : '') + '</p>' +
            '<span class="s-open">' + t('browseCat') + '</span>' +
          '</button>';
        }).join('') +
        '</div>';
      content.querySelectorAll('[data-cat]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          renderCategory(showcase[parseInt(btn.getAttribute('data-cat'), 10)]);
          window.scrollTo(0, 0);
        });
      });
    }

    function renderCategory(c) {
      var wr = winRateOf(c.category);
      var mine = mineByCat[c.category] || 0;
      content.innerHTML =
        '<div class="filter-row">' +
          '<button class="ghost-btn" id="back-cats">' + t('backCats') + '</button>' +
        '</div>' +
        '<div class="card" style="display:flex; justify-content:space-between; gap:14px; flex-wrap:wrap; align-items:center">' +
          '<div><h2>' + esc(trCat(c.category)) + '</h2>' +
          '<p class="sub">' + t('catHeadSub') +
            (wr !== null ? t('catWinInline', { pct: fmtPct(wr, 0) }) : '') +
            (mine ? t('catMineInline', { n: mine }) : '') + '</p></div>' +
        '</div>' +
        '<div class="store-grid">' +
        c.stores.map(function (st, i) {
          return '<section class="card store-card">' +
            '<div class="s-cat"><span class="rank-badge ' + (i === 0 ? 'top1' : i === 1 ? 'top2' : i === 2 ? 'top3' : '') + '">' + (i + 1) + '</span></div>' +
            '<div><h3>' + esc(st.name) + '</h3></div>' +
            '<div class="s-metrics">' +
              (canSeeVolume && st.ordersCount != null ? '<div class="s-metric"><b>' + fmtNum(st.ordersCount) + '</b><span>' + t('ordersAllTime') + '</span></div>' : '') +
              (canSeeVolume && st.revenue != null ? '<div class="s-metric"><b class="money-pos">' + fmtMoneyC(st.revenue) + '</b><span>' + t('revenueWord') + '</span></div>' : '') +
            '</div>' +
          '</section>';
        }).join('') +
        '</div>';
      document.getElementById('back-cats').addEventListener('click', function () {
        renderCategories();
        window.scrollTo(0, 0);
      });
    }

    renderCategories();
  }

  /* ---- Manager dashboard ---- */
  function viewManager(content) {
    var all = allLeads();
    var s = statsFor(all);
    var months = last12Months();
    // Most people submitting leads in HubSpot have never signed into the
    // app, so counting only registered users badly understates how many
    // hunters are actually running. Count everyone with at least one lead
    // and report sign-ups as the sub-figure instead.
    var signedUp = EMPLOYEES.filter(function (e) { return leadsOf(e.id).length > 0; }).length;
    var participants = signedUp + unregisteredHunterRows().length;
    // Merchants who have paid but whose deal is still sitting in an open
    // stage in HubSpot. The app counts them as won off the invoice, so
    // this is purely a nudge to go and fix the CRM record.
    var pendingClosure = all.filter(function (l) { return l.wonByInvoice; });
    var pendingAmount = pendingClosure.reduce(function (a, l) { return a + l.amountNet; }, 0);

    var byMonth = months.map(function (m) {
      return all.filter(function (l) { return monthKey(l.createdAt) === m.key; }).length;
    });
    var revByMonth = months.map(function (m) {
      return all.filter(function (l) { return l.stage === 'won' && monthKey(wonDate(l)) === m.key; })
        .reduce(function (a, l) { return a + l.amountNet; }, 0);
    });

    // Department comparison
    var depts = {};
    EMPLOYEES.forEach(function (e) {
      if (!depts[e.dept]) depts[e.dept] = { leads: 0, won: 0, revenue: 0 };
      var ls = leadsOf(e.id);
      depts[e.dept].leads += ls.length;
      ls.forEach(function (l) {
        if (l.stage === 'won') { depts[e.dept].won += 1; depts[e.dept].revenue += l.amountNet; }
      });
    });
    var deptRows = Object.keys(depts).map(function (d) {
      return { label: d, count: depts[d].leads, won: depts[d].won, revenue: depts[d].revenue };
    }).sort(function (a, b) { return b.revenue - a.revenue; });

    // Source performance — win rate over DECIDED leads only (same
    // definition as everywhere else), hidden below 3 decided.
    var sources = {};
    all.forEach(function (l) {
      if (!l.source) return; // portal submissions carry no source field
      if (!sources[l.source]) sources[l.source] = { total: 0, won: 0, decided: 0 };
      sources[l.source].total += 1;
      if (closedDate(l)) sources[l.source].decided += 1;
      if (l.stage === 'won') sources[l.source].won += 1;
    });
    var srcRows = Object.keys(sources).map(function (k) {
      return { label: k, count: sources[k].won, total: sources[k].total, decided: sources[k].decided };
    }).sort(function (a, b) { return b.count - a.count; });

    // Month-over-month comparison (this month vs last)
    var thisKey = monthKey(NOW);
    var lastKey = monthKey(new Date(NOW.getFullYear(), NOW.getMonth() - 1, 1));
    function aggMonth(key) {
      var wonM = all.filter(function (l) { return l.stage === 'won' && monthKey(wonDate(l)) === key; });
      return {
        leads: all.filter(function (l) { return monthKey(l.createdAt) === key; }).length,
        won: wonM.length,
        revenue: wonM.reduce(function (a, l) { return a + l.amountNet; }, 0),
        commission: wonM.reduce(function (a, l) { return a + commissionOf(l); }, 0)
      };
    }
    var mThis = aggMonth(thisKey), mLast = aggMonth(lastKey);
    function momDelta(cur, prev) {
      if (!prev && !cur) return '<span class="mom-flat">—</span>';
      if (!prev) return '<span class="mom-up">' + t('newDelta') + '</span>';
      var ch = (cur - prev) / prev;
      var cls = ch >= 0 ? 'mom-up' : 'mom-down';
      return '<span class="' + cls + '">' + (ch >= 0 ? '▲' : '▼') + ' ' + Math.abs(Math.round(ch * 100)) + '%</span>';
    }
    var momRows = [
      [t('momLeads'), fmtNum(mThis.leads), fmtNum(mLast.leads), momDelta(mThis.leads, mLast.leads)],
      [t('momStores'), fmtNum(mThis.won), fmtNum(mLast.won), momDelta(mThis.won, mLast.won)],
      [t('momRevenue'), fmtMoneyC(mThis.revenue), fmtMoneyC(mLast.revenue), momDelta(mThis.revenue, mLast.revenue)],
      [t('momCommission'), fmtMoneyC(mThis.commission), fmtMoneyC(mLast.commission), momDelta(mThis.commission, mLast.commission)]
    ];

    // Top packages sold (won deals by Zid plan) — the plan names come
    // straight from Metabase's Purchasable Name (via subscriptions), not
    // a fixed list, so whatever plans actually sold show up here.
    var planAgg = {};
    all.forEach(function (l) {
      if (l.stage !== 'won' || !l.plan) return;
      if (!planAgg[l.plan]) planAgg[l.plan] = { count: 0, revenue: 0 };
      planAgg[l.plan].count += 1;
      planAgg[l.plan].revenue += l.amountNet;
    });
    var planNames = Object.keys(planAgg).sort(function (a, b) { return planAgg[b].revenue - planAgg[a].revenue; });
    var planRevTotal = planNames.reduce(function (a, name) { return a + planAgg[name].revenue; }, 0) || 1;
    var PLAN_SHADES = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'];
    var PLAN_CLS = {};
    planNames.forEach(function (name, i) { PLAN_CLS[name] = PLAN_SHADES[i % PLAN_SHADES.length]; });

    // Category performance of won stores
    var catAgg = {};
    all.forEach(function (l) {
      if (l.stage !== 'won') return;
      if (!catAgg[l.industry]) catAgg[l.industry] = { count: 0, revenue: 0 };
      catAgg[l.industry].count += 1;
      catAgg[l.industry].revenue += l.amountNet;
    });
    var catRows = Object.keys(catAgg).map(function (k) {
      return { label: k, count: catAgg[k].count, revenue: catAgg[k].revenue };
    }).sort(function (a, b) { return b.revenue - a.revenue; }).slice(0, 6);

    // Sales rep performance on hunter leads
        var reps = {};
    all.forEach(function (l) {
      if (!reps[l.salesOwner]) reps[l.salesOwner] = { leads: 0, won: 0, lost: 0, unq: 0, open: 0, revenue: 0, stages: {} };
      var r = reps[l.salesOwner];
      r.leads += 1;
      if (l.stage === 'won') { r.won += 1; r.revenue += l.amountNet; }
      else if (l.stage === 'lost') r.lost += 1;
      else if (l.stage === 'unqualified') r.unq += 1;
      else { r.open += 1; r.stages[l.stage] = (r.stages[l.stage] || 0) + 1; }
    });
    var repRows = Object.keys(reps).map(function (name) {
      var r = reps[name];
      var decided = r.won + r.lost + r.unq;
      return { name: name, r: r, winRate: decided >= 3 ? r.won / decided : null };
    }).sort(function (a, b) { return b.r.revenue - a.r.revenue; });

    // Weighted forecast from the open pipeline (stage probability x value)
    var STAGE_WEIGHTS = { new: 0.1, prospect: 0.2, qualified: 0.35, sql: 0.5, commit: 0.75, reengage: 0.05 };
    var forecast = all.reduce(function (a, l) {
      return isOpen(l) ? a + l.amountNet * (STAGE_WEIGHTS[l.stage] || 0) : a;
    }, 0);

    // Coaching: enough leads, weak conversion
    var lb = leaderboardData().rows;
    var avgConv = s.conversion;
    var coach = lb.filter(function (r) { return r.s.total >= 8 && r.s.conversion < avgConv * 0.55; })
      .sort(function (a, b) { return a.s.conversion - b.s.conversion; });

    var reasonsLost = reasonTiles(s.lostReasons, s.lostNoReason);
    var reasonsUnq = reasonTiles(s.unqualReasons, s.unqualNoReason);

    // Live pipeline board: current count + value sitting in each stage
    var stageValue = {};
    STAGES.forEach(function (st) { stageValue[st.id] = 0; });
    all.forEach(function (l) { stageValue[l.stage] += l.amountNet; });
    var stageNowRows = STAGES.map(function (st) {
      var count = s.byStage[st.id];
      var val;
      if (st.group === 'open') val = fmtMoneyC(stageValue[st.id]);
      else if (st.group === 'won') val = '<b class="money-pos">' + fmtMoneyC(stageValue[st.id]) + '</b>';
      else val = '—';
      return '<tr><td>' + stagePill(st.id) + '</td><td class="num"><b>' + fmtNum(count) + '</b></td><td class="num">' + val + '</td></tr>';
    }).join('');

    content.innerHTML =
      '<div class="kpis">' +
        tile(t('activeHunters'), fmtNum(participants), t('ofSignedUp', { n: fmtNum(signedUp) })) +
        tile(t('totalLeads'), fmtNum(s.total), t('currentlyOpen', { n: fmtNum(s.open) })) +
        tile(t('newStores'), fmtNum(s.won), (s.avgCycleDays ? t('avgCycle', { n: s.avgCycleDays }) : t('wonMerchants'))) +
        tile(t('programConv'), fmtPct(s.conversion), t('convSub')) +
        tile(t('revenueClosed'), fmtMoneyC(s.revenueNet), s.won ? t('avgPerStore', { v: fmtMoneyC(s.revenueNet / s.won) }) : t('exVat')) +
        tile(t('revenueClosedGross'), fmtMoneyC(s.revenueGross), s.won ? t('avgPerStoreInc', { v: fmtMoneyC(s.revenueGross / s.won) }) : t('incVat')) +
        tile(t('pipelineValue'), fmtMoneyC(s.pipelineValue), t('openExVat')) +
        tile(t('commMonthTile'), fmtMoneyC(commThisMonthOf(all)), t('wonThisMonthSub')) +
        tile(t('commOwedPaid'), fmtMoneyC(s.commission), t('alreadyPaid', { v: fmtMoneyC(s.commissionPaid) })) +
        tile(t('forecastTile'), fmtMoneyC(forecast), t('forecastSub')) +
      '</div>' +

      // Only worth showing when there is something to chase; an
      // always-present "0" tile would just be noise on the dashboard.
      (pendingClosure.length ? pendingClosureCard(pendingClosure, pendingAmount) : '') +

      '<div class="grid-2">' +
        '<section class="card">' +
          '<div class="card-head"><div><h3>' + t('momTitle') + '</h3>' +
          '<p class="sub">' + t('momSub', { m1: NOW.toLocaleString(isAr() ? 'ar' : 'en', { month: 'long' }), d: NOW.getDate(), m2: new Date(NOW.getFullYear(), NOW.getMonth() - 1, 1).toLocaleString(isAr() ? 'ar' : 'en', { month: 'long' }) }) + '</p></div></div>' +
          '<div class="tbl-wrap"><table class="mini">' +
            '<thead><tr><th>' + t('metric') + '</th><th class="num">' + t('thisMonth') + '</th><th class="num">' + t('lastMonth') + '</th><th class="num">' + t('change') + '</th></tr></thead>' +
            '<tbody>' + momRows.map(function (r) {
              return '<tr><td>' + r[0] + '</td><td class="num"><b>' + r[1] + '</b></td><td class="num">' + r[2] + '</td><td class="num">' + r[3] + '</td></tr>';
            }).join('') + '</tbody>' +
          '</table></div>' +
        '</section>' +
        '<section class="card">' +
          '<div class="card-head"><div><h3>' + t('topPackages') + '</h3><p class="sub">' + t('topPackagesSub') + '</p></div></div>' +
          (planNames.length ? '<div class="legend">' + planNames.map(function (name) {
            return '<span class="lg"><i class="sw ' + PLAN_CLS[name] + '"></i>' + esc(trPlan(name)) + '</span>';
          }).join('') + '</div>' +
          stackedBarSVG(planNames.map(function (name) {
            return { label: t('zidPlan', { name: trPlan(name) }), count: planAgg[name].revenue, cls: PLAN_CLS[name] };
          }), { money: true, aria: 'Revenue share by package' }) +
          '<div class="tbl-wrap"><table class="mini">' +
            '<thead><tr><th>' + t('packageCol') + '</th><th class="num">' + t('stores') + '</th><th class="num">' + t('revenue') + '</th><th class="num">' + t('share') + '</th></tr></thead>' +
            '<tbody>' + planNames.map(function (name) {
              var a = planAgg[name];
              return '<tr><td>' + t('zidPlan', { name: esc(trPlan(name)) }) + '</td><td class="num">' + fmtNum(a.count) + '</td><td class="num"><b>' + fmtMoneyC(a.revenue) + '</b></td><td class="num">' + fmtPct(a.revenue / planRevTotal, 0) + '</td></tr>';
            }).join('') + '</tbody>' +
          '</table></div>'
            : '<div class="empty">' + t('noPackagesYet') + '</div>') +
        '</section>' +
      '</div>' +

      '<div class="grid-2">' +
        chartCard({
          title: t('programFunnel'), subtitle: t('programFunnelSub'),
          svg: funnelSVG(trFunnel(s.funnel)),
          table: { head: [t('stage'), t('reached')], rows: s.funnel.map(function (f) { return [trStage(f.stage), fmtNum(f.count)]; }) }
        }) +
        '<section class="card">' +
          '<div class="card-head"><div><h3>' + t('stageNow') + '</h3>' +
          '<p class="sub">' + t('stageNowSub') + '</p></div></div>' +
          '<div class="tbl-wrap"><table class="mini">' +
            '<thead><tr><th>' + t('stage') + '</th><th class="num">' + t('deals') + '</th><th class="num">' + t('valueExVat') + '</th></tr></thead>' +
            '<tbody>' + stageNowRows + '</tbody>' +
          '</table></div>' +
        '</section>' +
      '</div>' +

      '<div class="grid-2">' +
        '<section class="card">' +
          '<div class="card-head"><div><h3>' + t('outcomeSplit') + '</h3><p class="sub">' + t('allToDate', { n: fmtNum(s.total) }) + '</p></div></div>' +
          '<div class="legend">' +
            '<span class="lg"><i class="sw good"></i>' + t('won') + '</span><span class="lg"><i class="sw critical"></i>' + t('lost') + '</span>' +
            '<span class="lg"><i class="sw gray"></i>' + t('unqualified') + '</span><span class="lg"><i class="sw s1"></i>' + t('stillOpen') + '</span>' +
          '</div>' +
          stackedBarSVG([
            { label: t('closedWon'), count: s.won, cls: 'good' },
            { label: t('closedLost'), count: s.lost, cls: 'critical' },
            { label: t('unqualified'), count: s.unqualified, cls: 'gray' },
            { label: t('stillOpen'), count: s.open, cls: 's1' }
          ]) +
          '<div class="tbl-wrap"><table class="mini">' +
            '<thead><tr><th>' + t('outcome') + '</th><th class="num">' + t('leads') + '</th><th class="num">' + t('amount') + '</th></tr></thead>' +
            '<tbody>' +
              '<tr><td>' + t('closedWon') + '</td><td class="num"><b>' + fmtNum(s.won) + '</b></td><td class="num"><b class="money-pos">' + fmtMoneyC(s.revenueNet) + '</b> ' + t('revenueWord') + '</td></tr>' +
              '<tr><td>' + t('stillOpen') + '</td><td class="num"><b>' + fmtNum(s.open) + '</b></td><td class="num">' + t('inPlayWord', { v: fmtMoneyC(s.pipelineValue) }) + '</td></tr>' +
              '<tr><td>' + t('closedLost') + '</td><td class="num"><b>' + fmtNum(s.lost) + '</b></td><td class="num">—</td></tr>' +
              '<tr><td>' + t('unqualified') + '</td><td class="num"><b>' + fmtNum(s.unqualified) + '</b></td><td class="num">—</td></tr>' +
            '</tbody>' +
          '</table></div>' +
        '</section>' +
        chartCard({
          title: t('leadsByMonth'), subtitle: t('leadsByMonthProgram'),
          svg: columnsSVG(months.map(function (m) { return m.label; }), byMonth, { aria: 'Program leads by month' }),
          table: { head: [t('month'), t('leads')], rows: months.map(function (m, i) { return [m.label, fmtNum(byMonth[i])]; }) }
        }) +
      '</div>' +

      '<section class="card">' +
        '<div class="card-head"><div><h3>' + t('repPerf') + '</h3>' +
        '<p class="sub">' + t('repPerfSub') + '</p></div></div>' +
        '<div class="tbl-wrap"><table>' +
          '<thead><tr><th>' + t('salesRep') + '</th><th class="num">' + t('hunterLeads') + '</th><th class="num">' + t('won') + '</th><th class="num">' + t('lost') + '</th><th class="num">' + t('unqualified') + '</th><th class="num">' + t('winRate') + '</th><th class="num">' + t('revenueWon') + '</th><th>' + t('openNow') + '</th></tr></thead>' +
          '<tbody>' + repRows.map(function (row) {
            var r = row.r;
            var stageBits = Object.keys(r.stages).map(function (sid) {
              return r.stages[sid] + ' ' + trStage(STAGE_BY_ID[sid] ? STAGE_BY_ID[sid].label : sid);
            }).join(' · ');
            return '<tr>' +
              '<td><b>' + esc(row.name) + '</b></td>' +
              '<td class="num">' + fmtNum(r.leads) + '</td>' +
              '<td class="num"><b>' + fmtNum(r.won) + '</b></td>' +
              '<td class="num">' + fmtNum(r.lost) + '</td>' +
              '<td class="num">' + fmtNum(r.unq) + '</td>' +
              '<td class="num">' + (row.winRate === null ? '—' : fmtPct(row.winRate, 0)) + '</td>' +
              '<td class="num"><b>' + (r.revenue ? fmtMoneyC(r.revenue) : '—') + '</b></td>' +
              '<td>' + (r.open ? '<b>' + fmtNum(r.open) + '</b><span class="cell-sub">' + esc(stageBits) + '</span>' : '—') + '</td>' +
            '</tr>';
          }).join('') + '</tbody>' +
        '</table></div>' +
      '</section>' +

      '<div class="grid-2">' +
        chartCard({
          title: t('revByMonth'), subtitle: t('revByMonthSub'),
          svg: columnsSVG(months.map(function (m) { return m.label; }), revByMonth, { money: true, compact: true, aria: 'Revenue by month' }),
          table: { head: [t('month'), t('revenueSar')], rows: months.map(function (m, i) { return [m.label, fmtNum(revByMonth[i])]; }) }
        }) +
        '<section class="card">' +
          '<div class="card-head"><div><h3>' + t('deptComparison') + '</h3><p class="sub">' + t('deptSub') + '</p></div></div>' +
          '<div class="tbl-wrap"><table class="mini">' +
            '<thead><tr><th>' + t('department') + '</th><th class="num">' + t('leads') + '</th><th class="num">' + t('won') + '</th><th class="num">' + t('revenue') + '</th></tr></thead>' +
            '<tbody>' + deptRows.map(function (d) {
              return '<tr><td>' + esc(trDept(d.label)) + '</td><td class="num">' + fmtNum(d.count) + '</td><td class="num">' + fmtNum(d.won) + '</td><td class="num"><b>' + fmtMoneyC(d.revenue) + '</b></td></tr>';
            }).join('') + '</tbody>' +
          '</table></div>' +
        '</section>' +
      '</div>' +

      '<div class="grid-2">' +
        reasonTilesCard(t('topLostReasons'), t('programWideLost', { n: fmtNum(s.everLost) }), reasonsLost, 'critical') +
        reasonTilesCard(t('whyUnqProgram'), t('programWideUnq', { n: fmtNum(s.everUnqualified) }), reasonsUnq, 'gray') +
      '</div>' +

      '<div class="grid-2">' +
        '<section class="card">' +
          '<div class="card-head"><div><h3>' + t('sourcePerf') + '</h3><p class="sub">' + t('sourceSub') + '</p></div></div>' +
          '<div class="tbl-wrap"><table class="mini">' +
            '<thead><tr><th>' + t('source') + '</th><th class="num">' + t('leads') + '</th><th class="num">' + t('won') + '</th><th class="num">' + t('winRate') + '</th></tr></thead>' +
            '<tbody>' + srcRows.map(function (r) {
              return '<tr><td>' + esc(trSource(r.label)) + '</td><td class="num">' + fmtNum(r.total) + '</td><td class="num">' + fmtNum(r.count) + '</td><td class="num">' + (r.decided >= 3 ? fmtPct(r.count / r.decided, 0) : '—') + '</td></tr>';
            }).join('') + '</tbody>' +
          '</table></div>' +
        '</section>' +
        '<section class="card">' +
          '<div class="card-head"><div><h3>' + t('winsFrom') + '</h3><p class="sub">' + t('winsFromSub') + '</p></div></div>' +
          '<div class="tbl-wrap"><table class="mini">' +
            '<thead><tr><th>' + t('category') + '</th><th class="num">' + t('stores') + '</th><th class="num">' + t('revenue') + '</th><th class="num">' + t('avgDeal') + '</th></tr></thead>' +
            '<tbody>' + (catRows.length ? catRows.map(function (c) {
              return '<tr><td>' + esc(trCat(c.label)) + '</td><td class="num">' + fmtNum(c.count) + '</td><td class="num"><b>' + fmtMoneyC(c.revenue) + '</b></td><td class="num">' + fmtMoneyC(c.revenue / c.count) + '</td></tr>';
            }).join('') : '<tr><td colspan="4"><div class="empty">' + t('noWonStores') + '</div></td></tr>') + '</tbody>' +
          '</table></div>' +
        '</section>' +
      '</div>' +

      '<div class="grid-2">' +
        '<section class="card">' +
          '<div class="card-head"><div><h3>' + t('payoutStatus') + '</h3><p class="sub">' + t('payoutStatusSub') + '</p></div></div>' +
          '<div class="tbl-wrap"><table class="mini">' +
            '<thead><tr><th>' + t('status') + '</th><th class="num">' + t('amount') + '</th></tr></thead>' +
            '<tbody>' +
              '<tr><td><span class="status-chip pending">' + t('pendingApproval') + '</span></td><td class="num"><b>' + fmtMoney(s.commissionPending) + '</b></td></tr>' +
              '<tr><td><span class="status-chip approved">' + t('approvedPayroll') + '</span></td><td class="num"><b>' + fmtMoney(s.commissionApproved) + '</b></td></tr>' +
              '<tr><td><span class="status-chip paid">' + t('paidToDate') + '</span></td><td class="num"><b>' + fmtMoney(s.commissionPaid) + '</b></td></tr>' +
              '<tr><td>' + t('totalCommNet', { rate: ratePct() }) + '</td><td class="num"><b>' + fmtMoney(s.commission) + '</b></td></tr>' +
            '</tbody>' +
          '</table></div>' +
        '</section>' +
        '<section class="card">' +
          '<div class="card-head"><div><h3>' + t('coaching') + '</h3>' +
          '<p class="sub">' + t('coachingSub', { pct: fmtPct(avgConv, 0) }) + '</p></div></div>' +
          (coach.length ? coach.map(function (r) {
            return '<div class="coach-item">' + avatarHtml(r.emp) + '' +
              '<span><b>' + esc(r.emp.name) + '</b><span class="cell-sub">' + esc(trDept(r.emp.dept)) + ' · ' + fmtNum(r.s.total) + ' ' + t('leadsUnit') + '</span></span>' +
              '<span class="why">' + t('coachConv', { pct: fmtPct(r.s.conversion, 0) }) + '<br>' + t('coachUnq', { n: fmtNum(r.s.unqualified) }) + '</span></div>';
          }).join('') : '<div class="empty">' + t('nobodyFlagged') + '</div>') +
        '</section>' +
      '</div>' +

      '<section class="card">' +
        '<div class="card-head"><div><h3>' + t('perfStrip') + '</h3><p class="sub">' + t('perfStripSub') + '</p></div>' +
        '<a class="ghost-btn" href="#/performance" style="text-decoration:none">' + t('openBtn') + '</a></div>' +
      '</section>';
  }

  /* ---- Finance: hunter profile drawer (full payout details) ---- */
  function fmtIbanFull(iban) {
    return iban ? iban.replace(/(.{4})/g, '$1 ').trim() : t('notProvided');
  }
  function openHunterDrawer(empId) {
    var emp = (window.LIVE ? LIVE.users : EMPLOYEES).find(function (e) { return e.id === empId; });
    if (!emp) return;
    var saved = window.LIVE ? (function () {
      var pr = SH_API.profileOf(emp) || {};
      return { phone: pr.phone, personalEmail: pr.personal_email };
    })() : LS.get('profile.' + emp.id, {});
    var pay = payoutDetailsOf(emp);
    var s = statsFor(leadsOf(emp.id));
    var drawerCert = window.LIVE ? ((SH_API.profileOf(emp) || {}).iban_cert_path || '') : '';
    var old = document.getElementById('drawer-root');
    if (old) old.remove();

    var owed = s.commissionPending + s.commissionApproved;
    var roleTag = '<span class="role-badge ' + emp.role + '">' + roleName(emp.role) + '</span>' +
      extraAccessesOf(emp).map(function (rr) {
        return ' <span class="role-badge ' + rr + '">' + roleName(rr) + '</span>';
      }).join('');
    function kv(label, val, cls) { return '<dt>' + label + '</dt><dd' + (cls ? ' class="' + cls + '"' : '') + '>' + val + '</dd>'; }
    var root = el('<div id="drawer-root">' +
      '<div class="drawer-backdrop"></div>' +
      '<div class="drawer hunter-drawer" role="dialog" aria-label="Hunter profile">' +
        '<button class="icon-btn hd-close" id="drawer-close" aria-label="Close">✕</button>' +
        '<div class="hd-top">' +
          avatarHtml(emp, 'hd-avatar') +
          '<div class="hd-id"><h2>' + esc(emp.name) + '</h2>' +
            '<p class="sub">' + esc(emp.title || '') + (emp.dept ? ' · ' + esc(trDept(emp.dept)) : '') + '</p>' +
            '<div class="hd-badges">' + roleTag + '<span class="dot-badge active"><i></i>' + t('active') + '</span></div></div>' +
        '</div>' +

        '<div class="hd-stats">' +
          '<div class="hd-stat"><span>' + t('stillToPay') + '</span><b class="money-pos">' + fmtMoneyC(owed) + '</b></div>' +
          '<div class="hd-stat"><span>' + t('lifetime') + '</span><b>' + fmtMoneyC(s.commission) + '</b></div>' +
        '</div>' +

        '<div class="hd-section"><h4 class="hd-h">' + t('commissionSummary') + '</h4>' +
          '<dl class="hd-kv">' +
            kv(t('dealsWon'), fmtNum(s.won)) +
            kv(t('commMonthTile'), fmtMoneyC(commThisMonthOf(leadsOf(emp.id))), 'money-pos') +
            kv(t('paidToDate'), fmtMoneyC(s.commissionPaid)) +
          '</dl></div>' +

        '<div class="hd-section"><h4 class="hd-h">' + t('contact') + '</h4>' +
          '<dl class="hd-kv">' +
            kv(t('companyEmail'), esc(saved.companyEmail || emp.email)) +
            kv(t('mobile'), esc(saved.phone || emp.phone || '—')) +
            (saved.personalEmail ? kv(t('personalEmail'), esc(saved.personalEmail)) : '') +
          '</dl></div>' +

        '<div class="hd-section"><h4 class="hd-h">' + t('payoutAccount') + '</h4>' +
          '<dl class="hd-kv">' +
            kv(t('bank'), esc(trBank(pay.bank))) +
            kv(t('ibanLbl'), '<span style="font-variant-numeric:tabular-nums">' + esc(fmtIbanFull(pay.iban)) + '</span>') +
            kv(t('ibanCertLbl'), drawerCert ? '<button class="linklike" id="drawer-cert-view">' + t('viewDownload') + '</button>' : '<span class="cell-sub">' + t('notProvided') + '</span>') +
            (saved.nationalId ? kv(t('nationalId'), esc(saved.nationalId)) : '') +
          '</dl>' +
          '<p class="hd-note">' + t('fullIbanNote') + '</p>' +
        '</div>' +
        // Only offered for hunters — there is nothing to stand in for on a
        // management or finance account, and only management may do it.
        (canImpersonate(realUser()) && (!emp.role || emp.role === 'emp')
          ? '<div class="hd-section"><button class="ghost-btn hd-viewas" id="drawer-viewas">' +
            t('viewAsBtn', { name: esc(emp.name) }) + '</button>' +
            '<p class="hd-note">' + t('viewAsHint') + '</p></div>'
          : '') +
      '</div></div>');
    document.body.appendChild(root);
    var release = trapOverlay(root.querySelector('.drawer'), function () { close(); });
    function close() { release(); root.remove(); }
    root.querySelector('.drawer-backdrop').addEventListener('click', close);
    root.querySelector('#drawer-close').addEventListener('click', close);
    var dva = root.querySelector('#drawer-viewas');
    if (dva) dva.addEventListener('click', function () { close(); startViewAs(emp.id); });
    var dcv = root.querySelector('#drawer-cert-view');
    if (dcv) dcv.addEventListener('click', function () {
      SH_API.openIbanCert(drawerCert).catch(function (e2) { toast(String(e2.message)); });
    });
  }

  /* ---- Finance: hunter directory ---- */
  function viewHunters(content) {
    var hunterList = window.LIVE ? LIVE.users.filter(function (u) { return u.role === 'emp' && u.active; }) : EMPLOYEES;
    var all = hunterList.map(function (e) {
      var s = statsFor(leadsOf(e.id));
      return { e: e, s: s, pay: payoutDetailsOf(e) };
    }).sort(function (a, b) {
      return (b.s.commissionPending + b.s.commissionApproved) - (a.s.commissionPending + a.s.commissionApproved);
    });
    var page = 1, PER = 10, query = '';

    function render(focusSearch) {
      var q = query.trim().toLowerCase();
      var filtered = q ? all.filter(function (r) {
        return (r.e.name + ' ' + (r.e.email || '') + ' ' + (r.e.dept || '')).toLowerCase().indexOf(q) >= 0;
      }) : all;
      var totalPages = Math.max(1, Math.ceil(filtered.length / PER));
      if (page > totalPages) page = totalPages;
      var pageRows = filtered.slice((page - 1) * PER, page * PER);

      var rows = pageRows.map(function (r) {
        var owed = r.s.commissionPending + r.s.commissionApproved;
        return '<tr class="rowlink" data-hunter="' + r.e.id + '" tabindex="0">' +
          '<td><div class="u-cell">' + avatarHtml(r.e, 'u-av') + '' +
            '<div class="u-meta"><b>' + esc(r.e.name) + '</b><span class="cell-sub">' + esc(r.e.email || '—') + '</span></div></div></td>' +
          '<td class="num">' + fmtNum(r.s.won) + '</td>' +
          '<td class="num">' + (owed ? '<b class="money-pos">' + fmtMoney(owed) + '</b>' : '—') + '</td>' +
          '<td class="num">' + (r.s.commissionPaid ? fmtMoney(r.s.commissionPaid) : '—') + '</td>' +
          '<td style="white-space:nowrap">' + esc(trBank(r.pay.bank)) + '</td>' +
          '<td style="font-variant-numeric:tabular-nums; white-space:nowrap">' + esc(fmtIbanFull(r.pay.iban)) + '</td>' +
        '</tr>';
      }).join('');

      content.innerHTML =
        '<div class="filter-row">' +
          '<div style="display:flex; align-items:center; gap:10px"><h2>' + t('hunterProfiles') + '</h2>' +
            '<span class="count-badge">' + t('usersCount', { n: all.length }) + '</span></div>' +
          '<div class="spacer"></div>' +
          '<input type="search" id="h-search" class="tbl-search" placeholder="' + t('searchUsers') + '" value="' + esc(query) + '">' +
        '</div>' +
        '<section class="card">' +
          '<div class="tbl-wrap"><table>' +
            '<thead><tr><th>' + t('hunter') + '</th><th class="num">' + t('dealsWon') + '</th><th class="num">' + t('stillToPay') + '</th><th class="num">' + t('paidToDate') + '</th><th>' + t('bank') + '</th><th>' + t('ibanLbl') + '</th></tr></thead>' +
            '<tbody>' + (rows || '<tr><td colspan="6"><div class="empty">' + t('noneFound') + '</div></td></tr>') + '</tbody>' +
          '</table></div>' +
          '<div class="pager">' +
            '<span class="sub">' + t('pageOf', { p: page, n: totalPages }) + '</span>' +
            '<div style="display:flex; gap:8px">' +
              '<button class="btn secondary" id="hp-prev"' + (page <= 1 ? ' disabled' : '') + '>' + t('prev') + '</button>' +
              '<button class="btn secondary" id="hp-next"' + (page >= totalPages ? ' disabled' : '') + '>' + t('next') + '</button>' +
            '</div>' +
          '</div>' +
        '</section>' +
        '<p class="sub" style="text-align:center">' + t('hunterProfilesSub') + '</p>';

      var se = document.getElementById('h-search');
      se.addEventListener('input', function () { query = this.value; page = 1; render(true); });
      if (focusSearch) { se.focus(); se.setSelectionRange(se.value.length, se.value.length); }
      document.getElementById('hp-prev').addEventListener('click', function () { if (page > 1) { page--; render(); } });
      document.getElementById('hp-next').addEventListener('click', function () { if (page < totalPages) { page++; render(); } });
      content.querySelectorAll('[data-hunter]').forEach(function (tr) {
        function open() { openHunterDrawer(tr.getAttribute('data-hunter')); }
        tr.addEventListener('click', open);
        tr.addEventListener('keydown', function (e) { if (e.key === 'Enter') open(); });
      });
    }
    render();
  }

  /* ---- Finance: commission payouts ---- */
  function viewPayouts(content) {
    var statusFilter = 'all';
    var all = allLeads();
    var s = statsFor(all);
    var wonLeads = all.filter(function (l) { return l.stage === 'won'; })
      .sort(function (a, b) { return wonDate(b) - wonDate(a); });

    function rowsFor() {
      return wonLeads.filter(function (l) {
        return statusFilter === 'all' || commissionStatus(l) === statusFilter;
      });
    }

    function renderTable() {
      var canAct = roleOf() === 'fin'; // management views, finance acts
      var rows = rowsFor().map(function (l) {
        var hunter = (window.LIVE ? LIVE.users : EMPLOYEES).find(function (e) { return e.id === l.hunterId; });
        var pay = hunter ? payoutDetailsOf(hunter) : { bank: '—', iban: '' };
        var cs = commissionStatus(l);
        return '<tr>' +
          '<td>' + (hunter
            ? '<a href="#" class="hunter-link" data-hunter="' + hunter.id + '"><b>' + esc(hunter.name) + '</b></a><span class="cell-sub">' + esc(trDept(hunter.dept)) + '</span>'
            : l.hunterId === 'unassigned'
              ? '<b>' + t('unassigned') + '</b>'
              : '<b>' + esc(l.hunterId) + '</b><span class="cell-sub"><span class="unreg-pill" title="' + esc(t('notRegisteredHint')) + '">' + t('notRegistered') + '</span></span>') + '</td>' +
          '<td><b>' + esc(l.company) + '</b><span class="cell-sub">' + esc(l.id) + ' · ' + hubspotLinkHtml(l.id) + '</span></td>' +
          '<td>' + fmtDate(wonDate(l)) + '</td>' +
          '<td>' + esc(l.salesOwner) + '</td>' +
          '<td class="num">' + fmtMoney(l.amountNet) + '</td>' +
          '<td class="num"><b class="money-pos">' + fmtMoney(commissionOf(l)) + '</b></td>' +
          '<td>' + (canAct && cs !== 'awaiting'
            ? '<select class="status-select" data-deal="' + esc(l.id) + '" aria-label="Payment status for deal ' + esc(l.id) + '">' +
              [['pending', t('pendingApproval')], ['approved', t('approved')], ['paid', t('paid')]].map(function (o) {
                return '<option value="' + o[0] + '"' + (o[0] === cs ? ' selected' : '') + '>' + o[1] + '</option>';
              }).join('') + '</select>'
            // No commissions row exists yet — there is nothing to approve
            // or pay, so a select implying an action finance can take
            // would just throw when clicked. Show the state instead.
            : '<span class="status-chip ' + cs + '" title="' + (cs === 'awaiting' ? esc(t('awaitingCalcHint')) : '') + '">' + statusLabel(cs) + '</span>') + '</td>' +
          '<td>' + (cs === 'paid'
            ? (hasSlip(l.id)
                ? slipLink(l.id) + (canAct ? '<span class="cell-sub"><button class="linklike slip-up" data-deal="' + esc(l.id) + '">' + t('replace') + '</button></span>' : '')
                : (canAct ? '<button class="ghost-btn slip-up" data-deal="' + esc(l.id) + '">' + t('uploadPayslip') + '</button>' : '<span class="cell-sub">—</span>'))
            : '<span class="cell-sub">' + t('afterPayment') + '</span>') + '</td>' +
          '<td>' + esc(trBank(pay.bank)) + '<span class="cell-sub" style="font-variant-numeric:tabular-nums">' + esc(fmtIbanFull(pay.iban)) + '</span></td>' +
        '</tr>';
      }).join('');
      document.getElementById('payout-table').innerHTML =
        '<div class="tbl-wrap"><table>' +
          '<thead><tr><th>' + t('hunter') + '</th><th>' + t('deal') + '</th><th>' + t('closedWon') + '</th><th>' + t('closedBy') + '</th><th class="num">' + t('valueExVat') + '</th><th class="num">' + t('commissionPct', { rate: ratePct() }) + '</th><th>' + t('status') + '</th><th>' + t('payslip') + '</th><th>' + t('payoutAccount') + '</th></tr></thead>' +
          '<tbody>' + (rows || '<tr><td colspan="9"><div class="empty">' + t('noPayouts') + '</div></td></tr>') + '</tbody>' +
        '</table></div>';
      // .hs-link is now handled by the global delegated click listener,
      // so it works wherever hubspotLinkHtml() renders it (payouts here,
      // the manager dashboard's pending-closure card, etc.) — not just
      // this view.
      document.querySelectorAll('.hunter-link').forEach(function (a) {
        a.addEventListener('click', function (e) {
          e.preventDefault();
          openHunterDrawer(a.getAttribute('data-hunter'));
        });
      });
      document.querySelectorAll('.status-select').forEach(function (sel) {
        sel.addEventListener('change', function () {
          var dealId = sel.getAttribute('data-deal');
          if (window.LIVE) {
            SH_API.setCommissionStatus(dealId, sel.value).then(function () {
              toast(sel.value === 'paid' ? t('statusPaidToast', { id: dealId })
                                         : t('statusToast', { id: dealId, s: sel.options[sel.selectedIndex].text }));
              renderTiles(); renderTable();
            }).catch(function (e2) { toast(String(e2.message)); renderTable(); });
            return;
          }
          var overrides = LS.get('paystatus', {});
          overrides[dealId] = sel.value;
          LS.set('paystatus', overrides);
          COMMISSION_STATUS_OVERRIDES[dealId] = sel.value;
          audit('Set payment status of deal ' + dealId + ' to ' + sel.value);
          toast(sel.value === 'paid'
            ? t('statusPaidToast', { id: dealId })
            : t('statusToast', { id: dealId, s: sel.options[sel.selectedIndex].text }));
          renderTiles();
          renderTable();
        });
      });
      document.querySelectorAll('.slip-up').forEach(function (btn) {
        btn.addEventListener('click', function () {
          pendingSlipDeal = btn.getAttribute('data-deal');
          document.getElementById('slip-file').click();
        });
      });
    }

    function renderTiles() {
      var s = statsFor(allLeads());
      var owedTotal = s.commissionPending + s.commissionApproved;
      var huntersOwed = EMPLOYEES.filter(function (e) {
        var es = statsFor(leadsOf(e.id));
        return es.commissionPending + es.commissionApproved > 0;
      }).length;
      document.getElementById('payout-tiles').innerHTML =
        tile(t('stillToPay'), '<span class="money-pos">' + fmtMoneyC(owedTotal) + '</span>',
          t('pendingApprovedSub', { p: fmtMoneyC(s.commissionPending), a: fmtMoneyC(s.commissionApproved) })) +
        tile(t('paidToDate'), fmtMoneyC(s.commissionPaid), '') +
        tile(t('huntersAwaiting'), fmtNum(huntersOwed), t('seeProfiles')) +
        tile(t('commMonthTile'), fmtMoneyC(commThisMonthOf(allLeads())), t('wonThisMonthSub')) +
        tile(t('totalCommission'), fmtMoneyC(s.commission), t('pctOfNet', { rate: ratePct(), v: fmtMoneyC(s.revenueNet) }));
    }

    content.innerHTML =
      '<div class="kpis" id="payout-tiles"></div>' +
      '<div class="filter-row">' +
        '<div class="seg" id="status-seg">' + [['all', t('all')], ['pending', t('pending')], ['approved', t('approved')], ['paid', t('paid')]].map(function (x, i) {
          return '<button data-seg="' + x[0] + '" class="' + (i === 0 ? 'active' : '') + '">' + x[1] + '</button>';
        }).join('') + '</div>' +
        '<div class="spacer"></div>' +
        '<button class="btn secondary" id="dl-payouts">' + t('exportRun') + '</button>' +
      '</div>' +
      '<div class="card" id="payout-table"></div>' +
      '<input type="file" id="slip-file" hidden accept="application/pdf,image/png,image/jpeg">' +
      '<p class="sub" style="text-align:center">' + t('payoutNote') + '</p>';

    var pendingSlipDeal = null;
    document.getElementById('slip-file').addEventListener('change', function () {
      var f = this.files[0];
      this.value = '';
      if (!f || !pendingSlipDeal) return;
      if (f.size > 1.5 * 1024 * 1024) { toast(t('slipTooBig')); return; }
      var deal = pendingSlipDeal;
      if (window.LIVE) {
        SH_API.uploadPayslip(deal, f).then(function () {
          toast(t('slipToast', { id: deal }));
          renderTable();
        }).catch(function (e2) { toast(String(e2.message)); });
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        if (saveSlip(deal, { name: f.name, dataUrl: reader.result, uploadedAt: new Date().toISOString() })) {
          audit('Uploaded payslip “' + f.name + '” for deal ' + deal);
          toast(t('slipToast', { id: deal }));
          renderTable();
        } else {
          toast(t('slipFail'));
        }
      };
      reader.readAsDataURL(f);
    });

    document.querySelectorAll('#status-seg button').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('#status-seg button').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        statusFilter = b.getAttribute('data-seg');
        renderTable();
      });
    });
    document.getElementById('dl-payouts').addEventListener('click', function () {
      var lines = ['Hunter,Department,Deal ID,Company,Closed Won,Sales Rep,Value (SAR excl. VAT),Commission (SAR),Status,Bank,IBAN (masked)'];
      rowsFor().forEach(function (l) {
        var hunter = (window.LIVE ? LIVE.users : EMPLOYEES).find(function (e) { return e.id === l.hunterId; });
        var pay = hunter ? payoutDetailsOf(hunter) : { bank: '', iban: '' };
        lines.push([
          csvCell(hunter ? hunter.name : (l.hunterId === 'unassigned' ? t('unassigned') : l.hunterId)),
          csvCell(hunter ? hunter.dept : ''), csvCell(l.id),
          csvCell(l.company),
          fmtDate(wonDate(l)), csvCell(l.salesOwner),
          l.amountNet, Math.round(commissionOf(l)), commissionStatus(l),
          csvCell(pay.bank), pay.iban || ''
        ].join(','));
      });
      var blob = new Blob([lines.join('\n')], { type: 'text/csv' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'sales-hunter-payout-run.csv';
      a.click();
      URL.revokeObjectURL(a.href);
      toast(t('exportedToast'));
    });
    renderTiles();
    renderTable();
  }

  /* ---- Profile ---- */
  function viewProfile(content, user) {
    var saved;
    if (window.LIVE) {
      var pr = SH_API.profileOf(user) || {};
      saved = {
        phone: pr.phone || '', personalEmail: pr.personal_email || '', bank: pr.bank || '',
        iban: (LIVE.ibanByUser || {})[user.dbId] || (pr.iban_last4 ? ('SA000000000000000000' + pr.iban_last4) : '')
      };
    } else {
      saved = LS.get('profile.' + user.id, {});
    }
    var p = Object.assign({
      name: user.name, dept: user.dept, title: user.title,
      companyEmail: user.email, personalEmail: '', phone: user.phone || '',
      bank: user.bank || '', iban: user.iban || '', nationalId: ''
    }, saved);
    var certPath = window.LIVE ? ((SH_API.profileOf(user) || {}).iban_cert_path || '') : '';

    function field(id, label, type, value, hint, attrs) {
      return '<div><label class="f-label" for="' + id + '">' + esc(label) + '</label>' +
        '<input type="' + type + '" id="' + id + '" value="' + esc(value) + '" ' + (attrs || '') + '>' +
        (hint ? '<p class="f-hint">' + esc(hint) + '</p>' : '') +
        '<p class="f-error" id="' + id + '-err" hidden></p></div>';
    }

    var roleTag = '<span class="role-badge ' + user.role + '">' + roleName(user.role) + '</span>' +
      extraAccessesOf(user).map(function (rr) {
        return ' <span class="role-badge ' + rr + '">' + roleName(rr) + '</span>';
      }).join('');
    var st = statsFor(leadsOf(user.id));
    var owed = st.commissionPending + st.commissionApproved;
    // Photo controls are live-mode only (they need storage) — and never
    // while standing in for someone else. They sit in the summary aside,
    // outside #profile-form, so the read-only sweep at the end of this
    // view (which only disables form controls) never reached them; worse,
    // uploadAvatar/removeAvatar act on LIVE.me, so a manager clicking
    // "Remove photo" while viewing a hunter deleted their OWN photo.
    var canEditPhoto = !!window.LIVE && !readOnlyView();
    var googleAvail = canEditPhoto && SH_API.googleAvatarAvailable();
    var photoLinks = [];
    if (canEditPhoto) {
      if (user.avatar) photoLinks.push('<button type="button" class="linklike" id="av-remove">' + t('avRemove') + '</button>');
      if (googleAvail && user.avatarSource !== 'google') photoLinks.push('<button type="button" class="linklike" id="av-google">' + t('avUseGoogle') + '</button>');
    }
    var summary =
      '<aside class="card profile-summary">' +
        '<div class="ps-photo">' +
          avatarHtml(user, 'ps-avatar') +
          (canEditPhoto
            ? '<button type="button" class="ps-cam" id="av-pick" title="' + t('avChange') + '" aria-label="' + t('avChange') + '">' + ICONS.camera + '</button>' +
              '<input type="file" id="av-file" accept="image/png,image/jpeg,image/webp,image/gif" hidden>'
            : '') +
        '</div>' +
        (photoLinks.length ? '<p class="ps-photo-links">' + photoLinks.join('<span class="ps-sep">·</span>') + '</p>' : '') +
        '<h2>' + esc(user.name) + '</h2>' +
        '<p class="sub">' + esc(user.title || '') + (user.dept ? ' · ' + esc(trDept(user.dept)) : '') + '</p>' +
        '<div class="ps-badges">' + roleTag + '<span class="dot-badge active"><i></i>' + t('active') + '</span></div>' +
        '<div class="ps-divider"></div>' +
        '<dl class="ps-stats">' +
          '<div><dt>' + t('dealsWon') + '</dt><dd>' + fmtNum(st.won) + '</dd></div>' +
          '<div><dt>' + t('lifetime') + '</dt><dd class="money-pos">' + fmtMoneyC(st.commission) + '</dd></div>' +
          '<div><dt>' + t('stillToPay') + '</dt><dd>' + (owed ? fmtMoneyC(owed) : '—') + '</dd></div>' +
        '</dl>' +
      '</aside>';
    content.innerHTML =
      '<div class="profile-grid">' +
        summary +
        '<form id="profile-form" class="profile-form-col">' +
          '<section class="card">' +
            '<div class="card-head"><div><h3>' + t('contactInfo') + '</h3>' +
              '<p class="sub">' + t('contactInfoSub') + '</p></div></div>' +
            '<div class="form-grid">' +
              field('p-name', t('fullName').replace(' *', ''), 'text', p.name) +
              field('p-dept', t('deptLbl'), 'text', p.dept === 'General' ? '' : p.dept, '', 'placeholder="' + t('deptPh') + '"') +
              field('p-phone', t('mobile'), 'tel', p.phone, '', 'placeholder="+966555555928"') +
              field('p-cemail', t('companyEmail'), 'email', p.companyEmail, t('emailHint'), 'readonly style="opacity:.7"') +
              field('p-pemail', t('personalEmail'), 'email', p.personalEmail, '', 'placeholder="personal@gmail.com"') +
            '</div>' +
          '</section>' +
          '<section class="card">' +
            '<div class="card-head"><div><h3>' + t('payoutDetails') + '</h3>' +
              '<p class="sub">' + t(window.LIVE ? 'profileNoteLive' : 'profileNote') + '</p></div></div>' +
            '<div class="form-grid">' +
              '<div><label class="f-label" for="p-bank">' + t('bank') + '</label>' + bankSelect('p-bank', p.bank) + '</div>' +
              ibanBlock(p, certPath) +
              field('p-nid', t('nationalId'), 'text', p.nationalId, t('nationalIdHint')) +
            '</div>' +
          '</section>' +
          '<div class="profile-actions"><button type="submit" class="btn">' + t('saveProfile') + '</button></div>' +
        '</form>' +
      '</div>';

    wireBankOther('p-bank');
    if (canEditPhoto) {
      var avFile = document.getElementById('av-file');
      document.getElementById('av-pick').addEventListener('click', function () { avFile.click(); });
      avFile.addEventListener('change', function () {
        var f = this.files[0];
        if (!f) return;
        if (f.size > 2 * 1024 * 1024) { toast(t('avTooBig')); this.value = ''; return; }
        toast(t('avUploading'));
        SH_API.uploadAvatar(f).then(function () { toast(t('avUpdated')); route(); })
          .catch(function (e2) { toast(String(e2.message)); });
      });
      var avRm = document.getElementById('av-remove');
      if (avRm) avRm.addEventListener('click', function () {
        SH_API.removeAvatar().then(function () { toast(t('avRemoved')); route(); })
          .catch(function (e2) { toast(String(e2.message)); });
      });
      var avG = document.getElementById('av-google');
      if (avG) avG.addEventListener('click', function () {
        SH_API.useGoogleAvatar().then(function () { toast(t('avUpdated')); route(); })
          .catch(function (e2) { toast(String(e2.message)); });
      });
    }
    if (window.LIVE && document.getElementById('p-cert')) wireFileDrop('p-cert');
    var editBtn = document.getElementById('iban-edit');
    if (editBtn) editBtn.addEventListener('click', function () {
      document.getElementById('iban-view').hidden = true;
      document.getElementById('iban-edit-wrap').hidden = false;
      document.getElementById('p-iban').focus();
    });
    var certView = document.getElementById('iban-cert-view');
    if (certView) certView.addEventListener('click', function () {
      SH_API.openIbanCert(certPath).catch(function (e2) { toast(String(e2.message)); });
    });

    // Belt and braces: the controls are already disabled below while
    // impersonating, but never let a submit through under someone
    // else's identity.
    document.getElementById('profile-form').addEventListener('submit', function (e) {
      e.preventDefault();
      if (readOnlyView()) return;
      var ibanInput = document.getElementById('p-iban');
      var editing = !document.getElementById('iban-edit-wrap').hidden;
      var iban = ibanInput ? ibanInput.value.replace(/\s/g, '').toUpperCase() : '';
      var ibanErr = document.getElementById('p-iban-err');
      // a new/changed IBAN must be valid and (live) accompanied by a certificate
      if (editing && iban && !/^SA\d{22}$/.test(iban)) {
        ibanErr.textContent = t('ibanErr'); ibanErr.hidden = false; return;
      }
      var certFile = document.getElementById('p-cert') ? document.getElementById('p-cert').files[0] : null;
      if (window.LIVE && editing && iban && !certFile) {
        ibanErr.textContent = t('ibanCertNeeded'); ibanErr.hidden = false; return;
      }
      if (ibanErr) ibanErr.hidden = true;

      if (window.LIVE) {
        var payload = {
          name: document.getElementById('p-name').value.trim(),
          dept: document.getElementById('p-dept').value.trim(),
          phone: document.getElementById('p-phone').value,
          personalEmail: document.getElementById('p-pemail').value,
          bank: bankValue('p-bank'),
          iban: (editing && iban) ? iban : null // blank keeps the saved one
        };
        var btn = e.target.querySelector('button[type=submit]');
        btn.disabled = true;
        var chain = (editing && iban && certFile)
          ? SH_API.uploadIbanCert(certFile).then(function (path) { payload.ibanCertPath = path; })
          : Promise.resolve();
        chain.then(function () { return SH_API.saveProfile(payload); })
          .then(function () { toast(t('profileSaved')); route(); })
          .catch(function (e2) { toast(String(e2.message)); btn.disabled = false; });
        return;
      }
      if (!iban && p.iban) iban = p.iban; // demo: blank keeps the saved one
      LS.set('profile.' + user.id, {
        name: document.getElementById('p-name').value,
        dept: document.getElementById('p-dept').value,
        phone: document.getElementById('p-phone').value,
        companyEmail: document.getElementById('p-cemail').value,
        personalEmail: document.getElementById('p-pemail').value,
        bank: bankValue('p-bank'),
        iban: iban,
        nationalId: document.getElementById('p-nid').value
      });
      toast(t('profileSaved'));
    });

    // Viewing someone else's profile is look-only: grey out every control
    // so it is obvious nothing here can be changed from this seat.
    if (readOnlyView()) {
      var form = document.getElementById('profile-form');
      form.querySelectorAll('input, select, textarea, button').forEach(function (c) { c.disabled = true; });
      form.insertAdjacentHTML('afterbegin', '<p class="f-hint">' + esc(t('profileReadOnly')) + '</p>');
    }
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest('.slip-open');
    if (b && window.LIVE) {
      e.preventDefault();
      SH_API.openPayslip(b.getAttribute('data-deal')).catch(function (e2) { toast(String(e2.message)); });
      return;
    }
    // Fallback "open in HubSpot" link (hubspotLinkHtml, when the portal
    // id hasn't synced yet). Wired globally rather than per-view: it was
    // only handled inside viewPayouts's own render, so the same link
    // rendered by the manager dashboard's pending-closure card navigated
    // to a bare "#" — losing the expanded card and dumping the page back
    // to the home route.
    var hs = e.target.closest('.hs-link');
    if (hs) {
      e.preventDefault();
      toast(t('hsToast', { id: hs.getAttribute('data-deal') }));
    }
  });

  /* ---------------- Live data refresh ----------------
     The app used to load its snapshot once at sign-in and never again,
     so approvals/edits made elsewhere stayed invisible for hours. Now
     we re-pull on demand, when the tab regains focus, and periodically.
     Auto-refreshes never re-render over a form the user is using. */
  var refreshing = false;
  /* The lead form is the one view a re-render can't put back. In live
     mode it's a HubSpot embed we don't own: hbspt.forms.create() builds
     it into an empty slot, so replacing content.innerHTML drops every
     field the hunter had filled in and starts them over. With the
     default one-minute auto-refresh that happened WHILE they were
     typing — the form appeared to reload itself every minute and throw
     the entry away. Data still refreshes underneath; only the re-render
     is skipped, and route() runs normally the moment they navigate. */
  function onLeadForm() { return location.hash.replace(/^#/, '') === '/submit'; }
  /* Set the moment the user types into a form, cleared by route() (which
     has just rebuilt the view, so nothing typed survives anyway). The
     activeElement check below only covers a field that still has focus —
     someone who fills a form and then clicks a label, scrolls, or tabs
     to the submit button has a page full of entered data and a focused
     BODY, and used to lose the lot to the next auto-refresh.
     Scoped to fields inside a <form> so the table search and filter
     boxes, which live in plain .filter-row divs and hold nothing worth
     protecting, don't freeze the refresh for as long as someone leaves a
     search term typed in. */
  var formDirty = false;
  function markDirty(e) {
    var el2 = e.target;
    if (!el2 || !/^(INPUT|SELECT|TEXTAREA)$/.test(el2.tagName || '')) return;
    if (el2.closest && el2.closest('form')) formDirty = true;
  }
  document.addEventListener('input', markDirty, true);
  document.addEventListener('change', markDirty, true);
  function clearDirty() { formDirty = false; }
  function safeToRerender() {
    if (document.getElementById('ob-overlay') || document.getElementById('drawer-root')) return false;
    var ov = document.getElementById('au-overlay');
    if (ov && !ov.hidden) return false;
    if (document.querySelector('.ms-menu:not([hidden])')) return false; // access picker open
    if (onLeadForm() || formDirty) return false;
    var a = document.activeElement;
    if (a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) return false;
    // Focus inside an embedded form (HubSpot renders into an iframe on
    // some portals) surfaces as the IFRAME itself, never the field.
    if (a && a.tagName === 'IFRAME') return false;
    return true;
  }
  function doRefresh(manual) {
    if (refreshing || !window.LIVE || !window.SH_API) return;
    if (!manual && !safeToRerender()) return;
    refreshing = true;
    var btn = document.getElementById('refresh-btn');
    if (btn) btn.classList.add('spinning');
    SH_API.refresh().then(function (ok) {
      // Even an explicit refresh-button press leaves the lead form
      // standing: the fresh snapshot is loaded either way, and there is
      // nothing on that page a re-render would update.
      if (ok && !onLeadForm() && (manual || safeToRerender())) route();
      if (manual) toast(t('refreshed'));
    }).catch(function (e) {
      SH_API.logError(String(e.message), 'refresh');
      if (manual) toast(String(e.message));
    }).then(function () {
      refreshing = false;
      var b2 = document.getElementById('refresh-btn');
      if (b2) b2.classList.remove('spinning');
    });
  }
  document.addEventListener('visibilitychange', function () {
    // coming back to the tab after a while → get current data
    if (!document.hidden && window.LIVE && Date.now() - SH_API.lastLoaded() > 60000) doRefresh(false);
  });

  /* How often to auto-refresh, in minutes (0 = off). Per device. */
  function refreshMins() {
    var v = LS.get('refreshMins', 1);
    return typeof v === 'number' ? v : 1;
  }
  function updateFreshness() {
    var el2 = document.getElementById('freshness');
    if (!el2 || !window.LIVE || !SH_API.lastLoaded) return;
    var age = Math.floor((Date.now() - SH_API.lastLoaded()) / 60000);
    el2.textContent = age < 1 ? t('updatedNow') : t('updatedAgo', { n: age });
  }
  /* One ticker drives both the label and the auto-refresh, so the
     interval can change at runtime without re-arming timers. */
  setInterval(function () {
    updateFreshness();
    var mins = refreshMins();
    if (!mins || document.hidden || !window.LIVE) return;
    if (Date.now() - SH_API.lastLoaded() >= mins * 60000) doRefresh(false);
  }, 15000);

  /* Report uncaught failures so breakage is visible to management
     instead of dying silently in someone's browser. */
  window.addEventListener('error', function (e) {
    if (window.SH_API && SH_API.logError) SH_API.logError(e.message, 'window.error');
  });
  window.addEventListener('unhandledrejection', function (e) {
    var m = e.reason && (e.reason.message || e.reason);
    if (window.SH_API && SH_API.logError) SH_API.logError(String(m), 'unhandled');
  });

  /* ---------------- Boot ---------------- */
  applyTheme();
  applyLang();
  window.addEventListener('hashchange', route);
  if (window.SH_API && SH_API.enabled()) {
    SH_API.init().then(function (live) {
      if (!live) Object.assign(COMMISSION_STATUS_OVERRIDES, LS.get('paystatus', {}));
      route();
    });
  } else {
    Object.assign(COMMISSION_STATUS_OVERRIDES, LS.get('paystatus', {}));
    route();
  }
})();
