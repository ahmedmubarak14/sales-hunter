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
  function currentUser() {
    if (window.LIVE) return LIVE.me;
    var id = LS.get('user', null);
    if (!id) return null;
    var u = usersAll().find(function (x) { return x.id === id; });
    return u && u.active ? u : null;
  }
  /* A user with a secondary access (e.g. finance who also hunts) can
     switch which one is active; the choice sticks until sign-out. */
  function roleOf() {
    var u = currentUser();
    if (!u) return 'emp';
    var act = LS.get('activeRole', null);
    if (act && u.secondaryRole && (act === u.role || act === u.secondaryRole)) return act;
    return u.role;
  }
  function isManager() { return roleOf() === 'mgr'; }
  function homeOf(role) { return role === 'mgr' ? '/manager' : role === 'fin' ? '/payouts' : '/dashboard'; }

  /* Dynamic program settings (Management can change these) */
  var settings = LS.get('settings', {});
  if (settings.commissionRate) COMMISSION_RATE = settings.commissionRate;
  if (settings.vatRate) VAT_RATE = settings.vatRate;
  function ratePct() { return Math.round(COMMISSION_RATE * 100) + '%'; }
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
    var h = location.hash.replace(/^#/, '') || '/';
    if (!currentUser()) { renderLogin(); return; }
    /* users holding two accesses pick which one to enter with, once per sign-in */
    var cu = currentUser();
    if (cu.secondaryRole && !LS.get('activeRole', null)) { renderAccessChooser(cu); return; }
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
    var cards = [user.role, user.secondaryRole].map(function (rr) {
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
    var otherAccess = user.role !== 'emp' ? user.role
      : (user.secondaryRole && user.secondaryRole !== 'emp' ? user.secondaryRole : null);
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
          '<div class="topbar">' +
            '<div class="crumbs"><h1>' + esc(t(r.titleKey)) + '</h1>' + (window.LIVE ? '' : '<span class="demo-pill">' + t('demoPill') + '</span>') + '</div>' +
            '<div class="actions">' +
              (user.secondaryRole ? '<div class="role-switch" role="group" aria-label="' + t('switchAccess') + '">' +
                [user.role, user.secondaryRole].map(function (rr) {
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

    document.getElementById('logout').addEventListener('click', function () {
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
    if (needsOb) openOnboardingModal();
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

    var reasonsLost = Object.keys(s.lostReasons).map(function (k) { return { label: trReason(k), count: s.lostReasons[k] }; })
      .sort(function (a, b) { return b.count - a.count; });
    var reasonsUnq = Object.keys(s.unqualReasons).map(function (k) { return { label: trReason(k), count: s.unqualReasons[k] }; })
      .sort(function (a, b) { return b.count - a.count; });

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
        reasonTilesCard(t('whyLost'), t('whyLostSub', { n: fmtNum(s.lost) }), reasonsLost, 'critical') +
        reasonTilesCard(t('whyUnq'), t('whyUnqSub', { n: fmtNum(s.unqualified) }), reasonsUnq, 'gray') +
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
        ' <span class="status-chip ' + cs + '">' + (cs === 'paid' ? t('paid') : cs === 'approved' ? t('approved') : t('pendingApproval')) + '</span></dd>';
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

  function renderHubspotForm(content, user) {
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
    var iv = setInterval(function () {
      tries++;
      if (build() || tries > 60) clearInterval(iv);
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
        '<td><span class="status-chip ' + cs + '">' + (cs === 'paid' ? t('paid') : cs === 'approved' ? t('approved') : t('pendingApproval')) + '</span>' +
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
        lines.push([l.id, '"' + l.company.replace(/"/g, '""') + '"', fmtDate(wonDate(l)), l.amountNet, commissionOf(l), commissionStatus(l)].join(','));
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

  function leaderboardData() {
    var thisMonthKey = monthKey(NOW);
    var rows = EMPLOYEES.map(function (e) {
      var leads = leadsOf(e.id);
      var s = statsFor(leads);
      var revThisMonth = leads.filter(function (l) {
        return l.stage === 'won' && monthKey(wonDate(l)) === thisMonthKey;
      }).reduce(function (a, l) { return a + l.amountNet; }, 0);
      return { emp: e, s: s, revThisMonth: revThisMonth };
    });
    var topThisMonth = rows.slice().sort(function (a, b) { return b.revThisMonth - a.revThisMonth; })[0];
    return { rows: rows, topThisMonthId: topThisMonth && topThisMonth.revThisMonth > 0 ? topThisMonth.emp.id : null };
  }

  /* Hunters with real deals (hunterId is just their lowercased email —
     see toLead() in api.js) but no app_users account yet. Nothing to
     "link" later: the moment someone registers with that same email,
     EMPLOYEES picks them up and leadsOf() matches their existing deals
     automatically, since attribution is the email itself. */
  function unregisteredHunterRows() {
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
      out.push({ emp: { id: id, name: name || id, dept: '', title: '', email: id, avatar: null }, s: statsFor(leadsOf(id)) });
    });
    return out;
  }

  /* Management-only ranking (replaces the shared leaderboard — hunters
     see only their own numbers, for privacy) */
  function viewPerformance(content) {
    var data = leaderboardData();
    var regRows = data.rows.map(function (r) { return Object.assign({ registered: true }, r); });
    var unregRows = unregisteredHunterRows().map(function (r) { return Object.assign({ registered: false }, r); });
    var regFilter = 'all';

    function rowsFor() {
      var rows = regFilter === 'reg' ? regRows : regFilter === 'unreg' ? unregRows : regRows.concat(unregRows);
      return rows.slice().sort(function (a, b) { return b.s.revenueNet - a.s.revenueNet; });
    }

    function renderTable() {
      var rows = rowsFor();
      var maxRev = Math.max.apply(null, rows.map(function (r) { return r.s.revenueNet; }).concat([1]));

      var body = rows.map(function (r, i) {
        var rankCls = i === 0 ? 'top1' : i === 1 ? 'top2' : i === 2 ? 'top3' : '';
        var badges = r.registered ? badgesFor(r.emp.id, r.s, data.topThisMonthId) : [];
        var who = r.registered
          ? esc(trDept(r.emp.dept))
          : '<span class="unreg-pill" title="' + esc(t('notRegisteredHint')) + '">' + t('notRegistered') + '</span>';
        return '<tr>' +
          '<td><span class="rank-badge ' + rankCls + '">' + (i + 1) + '</span></td>' +
          '<td><b>' + esc(r.emp.name) + '</b><span class="cell-sub">' + who + '</span></td>' +
          '<td class="num">' + fmtNum(r.s.total) + '</td>' +
          '<td class="num">' + fmtNum(r.s.won) + '</td>' +
          '<td class="num">' + fmtPct(r.s.conversion, 0) + '</td>' +
          '<td style="min-width:120px"><div class="progress-track"><div class="progress-fill" style="width:' + Math.round(r.s.revenueNet / maxRev * 100) + '%"></div></div></td>' +
          '<td class="num"><b>' + fmtMoneyC(r.s.revenueNet) + '</b></td>' +
          '<td class="num">' + fmtMoneyC(r.s.commission) + '</td>' +
          '<td><div class="badges">' + badges.map(function (b) { return '<span class="badge-chip">' + esc(b) + '</span>'; }).join('') + '</div></td>' +
        '</tr>';
      }).join('');

      document.getElementById('perf-table').innerHTML =
        '<div class="tbl-wrap"><table>' +
          '<thead><tr><th></th><th>' + t('hunter') + '</th><th class="num">' + t('leads') + '</th><th class="num">' + t('won') + '</th><th class="num">' + t('conversion') + '</th><th>' + t('revenue') + '</th><th class="num"></th><th class="num">' + t('commissionCol') + '</th><th>' + t('achievements') + '</th></tr></thead>' +
          '<tbody>' + (body || '<tr><td colspan="9"><div class="empty">' + t('noHuntersFilter') + '</div></td></tr>') + '</tbody>' +
        '</table></div>';
    }

    var segOpts = [['all', t('all')], ['reg', t('registered')], ['unreg', t('notRegistered')]];
    content.innerHTML =
      '<section class="card">' +
        '<div class="card-head"><div><h3>' + t('allTimeRanking') + '</h3>' +
        '<p class="sub">' + t('rankingSub') + '</p></div>' +
        '<div class="seg" id="reg-seg">' + segOpts.map(function (s, i) {
          return '<button data-seg="' + s[0] + '" class="' + (i === 0 ? 'active' : '') + '">' + s[1] + '</button>';
        }).join('') + '</div>' +
        '</div>' +
        '<div id="perf-table"></div>' +
      '</section>';

    document.querySelectorAll('#reg-seg button').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('#reg-seg button').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        regFilter = b.getAttribute('data-seg');
        renderTable();
      });
    });
    renderTable();
  }

  /* ---- Management backoffice: team & access ---- */
  function viewTeam(content, user) {
    function saveOverride(id, patch) {
      var over = LS.get('userOverrides', {});
      over[id] = Object.assign(over[id] || {}, patch);
      LS.set('userOverrides', over);
    }

    var editingId = null, page = 1, PER = 10, query = '';
    var ROLE_OPTS = ['emp', 'mgr', 'fin'];

    function roleBadge(r) { return '<span class="role-badge ' + r + '">' + roleName(r) + '</span>'; }

    function secOptions(primary, current) {
      return [''].concat(ROLE_OPTS.filter(function (r) { return r !== primary; })).map(function (r) {
        return '<option value="' + r + '"' + ((current || '') === r ? ' selected' : '') + '>' + (r ? roleName(r) : t('noneOpt')) + '</option>';
      }).join('');
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
            (isSelf
              ? roleBadge(u.role)
              : '<select class="mini-select role-select" data-user="' + esc(u.id) + '" aria-label="' + t('role').replace(' *', '') + '">' +
                  ROLE_OPTS.map(function (r) { return '<option value="' + r + '"' + (r === u.role ? ' selected' : '') + '>' + roleName(r) + '</option>'; }).join('') + '</select>') +
            '<select class="mini-select sec-select" data-user="' + esc(u.id) + '" aria-label="' + t('extraAccess') + '">' + secOptions(u.role, u.secondaryRole) + '</select>' +
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
                '<div id="nu-sec-group"><label class="f-label" for="nu-sec">' + t('extraAccess') + '</label><select id="nu-sec">' + secOptions('emp', '') + '</select></div>' +
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

      function syncSec() {
        var primary = document.getElementById('nu-role').value;
        var sec = document.getElementById('nu-sec');
        var cur = sec.value;
        sec.innerHTML = secOptions(primary, cur === primary ? '' : cur);
      }
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
        document.getElementById('nu-sec').innerHTML = secOptions(u ? u.role : 'emp', u ? u.secondaryRole : '');
        // role + extra access are edited inline in the table; the form
        // only sets them when creating a new user.
        document.getElementById('nu-role-group').hidden = !!u;
        document.getElementById('nu-sec-group').hidden = !!u;
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
      document.getElementById('nu-role').addEventListener('change', syncSec);
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
        var nuSec = document.getElementById('nu-sec').value || null;
        if (nuSec === nuRole) nuSec = null;
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
              toast(t('userSavedToast', { name: name })); editingId = null; render();
            }).catch(function (e2) { toast(String(e2.message)); });
            return;
          }
          saveOverride(editingId, patch);
          audit('Edited user ' + name);
          toast(t('userSavedToast', { name: name }));
          editingId = null; render();
          return;
        }
        if (window.LIVE) {
          SH_API.addUser(nu).then(function (created) {
            if (nuSec && created) return SH_API.patchUser(created.email, { secondaryRole: nuSec });
          }).then(function () {
            toast(t('userAddedToast', { name: name })); render();
          }).catch(function (e2) { toast(String(e2.message)); });
          return;
        }
        var custom = LS.get('users', []);
        custom.push(Object.assign({ id: 'u' + (100 + custom.length), code: String(8681849300 + custom.length), secondaryRole: nuSec }, nu));
        LS.set('users', custom);
        audit('Added user ' + name + ' (' + roleName(nuRole) + ')');
        toast(t('userAddedToast', { name: name }));
        render();
      });
      content.querySelectorAll('.edit-user').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var u = usersAll().find(function (x) { return x.id === btn.getAttribute('data-user'); });
          if (u) openForm(u);
        });
      });
      content.querySelectorAll('.role-select').forEach(function (sel) {
        sel.addEventListener('change', function () {
          var id = sel.getAttribute('data-user');
          var u = usersAll().find(function (x) { return x.id === id; });
          // if the new primary role collides with the extra access, clear the extra
          var patch = { role: sel.value };
          if (u && u.secondaryRole === sel.value) patch.secondaryRole = null;
          if (window.LIVE) {
            SH_API.patchUser(id, patch).then(function () {
              toast(t('roleUpdated', { role: roleName(sel.value) })); render();
            }).catch(function (e2) { toast(String(e2.message)); render(); });
            return;
          }
          saveOverride(id, patch);
          audit('Changed role of ' + (u ? u.name : id) + ' to ' + roleName(sel.value));
          toast(t('roleUpdated', { role: roleName(sel.value) }));
          render();
        });
      });
      content.querySelectorAll('.sec-select').forEach(function (sel) {
        sel.addEventListener('change', function () {
          var id = sel.getAttribute('data-user');
          var val = sel.value || null;
          if (window.LIVE) {
            SH_API.patchUser(id, { secondaryRole: val }).then(function () {
              toast(t('accessUpdated')); render();
            }).catch(function (e2) { toast(String(e2.message)); render(); });
            return;
          }
          saveOverride(id, { secondaryRole: val });
          audit('Set extra access of ' + id + ' to ' + (val ? roleName(val) : 'none'));
          toast(t('accessUpdated'));
          render();
        });
      });
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
              fieldRow('hs-owner', t('intgOwnerProp'), hsS.owner_prop || '', 'hubspot_owner_id') +
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
              fieldRow('mb-stores', t('intgCardStores'), mbS.card_topstores || '', 'e.g. 144') +
            '</div>' +
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
          owner_prop: document.getElementById('hs-owner').value.trim(),
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
          card_subscriptions: document.getElementById('mb-subs').value.trim(),
          card_topstores: document.getElementById('mb-stores').value.trim()
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
              '<input type="number" id="set-rate" min="1" max="50" step="0.5" value="' + (COMMISSION_RATE * 100) + '">' +
              '<p class="f-hint">' + t('currentRate', { rate: ratePct() }) + '</p></div>' +
            '<div><label class="f-label" for="set-vat">' + t('vatLbl') + '</label>' +
              '<input type="number" id="set-vat" min="0" max="30" step="1" value="' + (VAT_RATE * 100) + '">' +
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
            (wr !== null ? '<span class="s-city">' + t('catWinRate', { pct: fmtPct(wr, 0) }) + '</span>' : '') + '</div>' +
            '<div><h3>' + t('no1', { name: esc(leader.name) }) + '</h3><span class="s-city">' + esc(trCity(leader.city)) +
              (leader.ordersMo != null ? ' · ' + fmtNum(leader.ordersMo) + ' ' + t('ordersMo') : '') + '</span></div>' +
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
            '<div class="s-cat"><span class="rank-badge ' + (i === 0 ? 'top1' : i === 1 ? 'top2' : i === 2 ? 'top3' : '') + '">' + (i + 1) + '</span>' +
            '<span class="s-city">' + esc(trCity(st.city)) + '</span></div>' +
            '<div><h3>' + esc(st.name) + '</h3></div>' +
            '<div class="s-metrics">' +
              (st.ordersMo != null ? '<div class="s-metric"><b>' + fmtNum(st.ordersMo) + '</b><span>' + t('ordersMo') + '</span></div>' : '') +
              '<div class="s-metric"><b class="money-pos">+' + Math.round(st.growth * 100) + '%</b><span>' + t('growthYear') + '</span></div>' +
            '</div>' +
            '<p class="s-blurb">' + esc(st.blurb) + '</p>' +
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
    var participants = EMPLOYEES.filter(function (e) { return leadsOf(e.id).length > 0; }).length;

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

    // Top packages sold (won deals by Zid plan — ordered tiers)
    var planAgg = {};
    PLANS.forEach(function (p) { planAgg[p.name] = { count: 0, revenue: 0 }; });
    all.forEach(function (l) {
      if (l.stage === 'won' && l.plan && planAgg[l.plan]) {
        planAgg[l.plan].count += 1;
        planAgg[l.plan].revenue += l.amountNet;
      }
    });
    var planRevTotal = PLANS.reduce(function (a, p) { return a + planAgg[p.name].revenue; }, 0) || 1;
    var PLAN_CLS = { Launch: 'f2', Growth: 'f4', Professional: 'f6' };

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

    var reasonsLost = Object.keys(s.lostReasons).map(function (k) { return { label: trReason(k), count: s.lostReasons[k] }; })
      .sort(function (a, b) { return b.count - a.count; });
    var reasonsUnq = Object.keys(s.unqualReasons).map(function (k) { return { label: trReason(k), count: s.unqualReasons[k] }; })
      .sort(function (a, b) { return b.count - a.count; });

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
        tile(t('activeHunters'), fmtNum(participants), t('ofEnrolled', { n: EMPLOYEES.length })) +
        tile(t('totalLeads'), fmtNum(s.total), t('currentlyOpen', { n: fmtNum(s.open) })) +
        tile(t('newStores'), fmtNum(s.won), (s.avgCycleDays ? t('avgCycle', { n: s.avgCycleDays }) : t('wonMerchants'))) +
        tile(t('programConv'), fmtPct(s.conversion), t('convSub')) +
        tile(t('revenueClosed'), fmtMoneyC(s.revenueNet), s.won ? t('avgPerStore', { v: fmtMoneyC(s.revenueNet / s.won) }) : t('exVat')) +
        tile(t('pipelineValue'), fmtMoneyC(s.pipelineValue), t('openExVat')) +
        tile(t('commMonthTile'), fmtMoneyC(commThisMonthOf(all)), t('wonThisMonthSub')) +
        tile(t('commOwedPaid'), fmtMoneyC(s.commission), t('alreadyPaid', { v: fmtMoneyC(s.commissionPaid) })) +
        tile(t('forecastTile'), fmtMoneyC(forecast), t('forecastSub')) +
      '</div>' +

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
          '<div class="legend">' + PLANS.map(function (p) {
            return '<span class="lg"><i class="sw ' + PLAN_CLS[p.name] + '"></i>' + esc(trPlan(p.name)) + '</span>';
          }).join('') + '</div>' +
          stackedBarSVG(PLANS.map(function (p) {
            return { label: t('zidPlan', { name: trPlan(p.name) }), count: planAgg[p.name].revenue, cls: PLAN_CLS[p.name] };
          }), { money: true, aria: 'Revenue share by package' }) +
          '<div class="tbl-wrap"><table class="mini">' +
            '<thead><tr><th>' + t('packageCol') + '</th><th class="num">' + t('stores') + '</th><th class="num">' + t('revenue') + '</th><th class="num">' + t('share') + '</th></tr></thead>' +
            '<tbody>' + PLANS.map(function (p) {
              var a = planAgg[p.name];
              return '<tr><td>' + t('zidPlan', { name: esc(trPlan(p.name)) }) + '</td><td class="num">' + fmtNum(a.count) + '</td><td class="num"><b>' + fmtMoneyC(a.revenue) + '</b></td><td class="num">' + fmtPct(a.revenue / planRevTotal, 0) + '</td></tr>';
            }).join('') + '</tbody>' +
          '</table></div>' +
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
        reasonTilesCard(t('topLostReasons'), t('programWideLost', { n: fmtNum(s.lost) }), reasonsLost, 'critical') +
        reasonTilesCard(t('whyUnqProgram'), t('programWideUnq', { n: fmtNum(s.unqualified) }), reasonsUnq, 'gray') +
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
      (emp.secondaryRole ? ' <span class="role-badge ' + emp.secondaryRole + '">' + roleName(emp.secondaryRole) + '</span>' : '');
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
      '</div></div>');
    document.body.appendChild(root);
    var release = trapOverlay(root.querySelector('.drawer'), function () { close(); });
    function close() { release(); root.remove(); }
    root.querySelector('.drawer-backdrop').addEventListener('click', close);
    root.querySelector('#drawer-close').addEventListener('click', close);
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
            : '<b>Unknown</b>') + '</td>' +
          '<td><b>' + esc(l.company) + '</b><span class="cell-sub">' + esc(l.id) + ' · <a href="#" class="hs-link" data-deal="' + esc(l.id) + '">' + t('openHubspot') + '</a></span></td>' +
          '<td>' + fmtDate(wonDate(l)) + '</td>' +
          '<td>' + esc(l.salesOwner) + '</td>' +
          '<td class="num">' + fmtMoney(l.amountNet) + '</td>' +
          '<td class="num"><b class="money-pos">' + fmtMoney(commissionOf(l)) + '</b></td>' +
          '<td>' + (canAct
            ? '<select class="status-select" data-deal="' + esc(l.id) + '" aria-label="Payment status for deal ' + esc(l.id) + '">' +
              [['pending', t('pendingApproval')], ['approved', t('approved')], ['paid', t('paid')]].map(function (o) {
                return '<option value="' + o[0] + '"' + (o[0] === cs ? ' selected' : '') + '>' + o[1] + '</option>';
              }).join('') + '</select>'
            : '<span class="status-chip ' + cs + '">' + (cs === 'paid' ? t('paid') : cs === 'approved' ? t('approved') : t('pendingApproval')) + '</span>') + '</td>' +
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
      document.querySelectorAll('.hs-link').forEach(function (a) {
        a.addEventListener('click', function (e) {
          e.preventDefault();
          toast(t('hsToast', { id: a.getAttribute('data-deal') }));
        });
      });
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
          '"' + (hunter ? hunter.name : 'Unknown').replace(/"/g, '""') + '"',
          hunter ? hunter.dept : '', l.id,
          '"' + l.company.replace(/"/g, '""') + '"',
          fmtDate(wonDate(l)), '"' + l.salesOwner + '"',
          l.amountNet, commissionOf(l), commissionStatus(l),
          '"' + pay.bank + '"', pay.iban || ''
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
      (user.secondaryRole ? ' <span class="role-badge ' + user.secondaryRole + '">' + roleName(user.secondaryRole) + '</span>' : '');
    var st = statsFor(leadsOf(user.id));
    var owed = st.commissionPending + st.commissionApproved;
    // photo controls are live-mode only (they need storage)
    var canEditPhoto = !!window.LIVE;
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

    document.getElementById('profile-form').addEventListener('submit', function (e) {
      e.preventDefault();
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
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest('.slip-open');
    if (b && window.LIVE) {
      e.preventDefault();
      SH_API.openPayslip(b.getAttribute('data-deal')).catch(function (e2) { toast(String(e2.message)); });
    }
  });

  /* ---------------- Live data refresh ----------------
     The app used to load its snapshot once at sign-in and never again,
     so approvals/edits made elsewhere stayed invisible for hours. Now
     we re-pull on demand, when the tab regains focus, and periodically.
     Auto-refreshes never re-render over a form the user is using. */
  var refreshing = false;
  function safeToRerender() {
    if (document.getElementById('ob-overlay') || document.getElementById('drawer-root')) return false;
    var ov = document.getElementById('au-overlay');
    if (ov && !ov.hidden) return false;
    var a = document.activeElement;
    if (a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) return false;
    return true;
  }
  function doRefresh(manual) {
    if (refreshing || !window.LIVE || !window.SH_API) return;
    if (!manual && !safeToRerender()) return;
    refreshing = true;
    var btn = document.getElementById('refresh-btn');
    if (btn) btn.classList.add('spinning');
    SH_API.refresh().then(function (ok) {
      if (ok && (manual || safeToRerender())) route();
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
