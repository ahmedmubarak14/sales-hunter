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
  var ROLE_NAMES = { emp: 'Hunter', mgr: 'Management', fin: 'Finance' };
  function baseUsers() {
    return EMPLOYEES.map(function (e) { return Object.assign({ role: 'emp' }, e); })
      .concat([Object.assign({ role: 'mgr' }, MANAGER), Object.assign({ role: 'fin' }, FINANCE)]);
  }
  function usersAll() {
    var custom = LS.get('users', []);
    var over = LS.get('userOverrides', {});
    return baseUsers().concat(custom).map(function (u) {
      return Object.assign({ active: true }, u, over[u.id] || {});
    });
  }
  function currentUser() {
    var id = LS.get('user', null);
    if (!id) return null;
    var u = usersAll().find(function (x) { return x.id === id; });
    return u && u.active ? u : null;
  }
  function roleOf() { return (currentUser() || {}).role || 'emp'; }
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
  function slipLink(dealId, cls) {
    var slip = getSlips()[dealId];
    if (!slip) return '';
    return '<a class="' + (cls || '') + '" href="' + slip.dataUrl + '" download="' + esc(slip.name) + '">Payslip ↓</a>';
  }

  /* Payout details: saved profile overrides the employee defaults */
  function payoutDetailsOf(emp) {
    var saved = LS.get('profile.' + emp.id, {});
    return { bank: saved.bank || emp.bank, iban: saved.iban || emp.iban };
  }
  function maskIban(iban) { return iban ? 'SA·· ···· ' + iban.slice(-4) : '—'; }

  /* Leads submitted through the demo form (persisted locally) */
  function customLeads() {
    return LS.get('leads', []).map(function (l) {
      return Object.assign({}, l, {
        createdAt: new Date(l.createdAt),
        events: l.events.map(function (e) { return { stage: e.stage, date: new Date(e.date) }; })
      });
    });
  }
  function allLeads() { return customLeads().concat(LEADS); }
  function leadsOf(empId) { return allLeads().filter(function (l) { return l.hunterId === empId; }); }

  /* ---------------- Theme ---------------- */
  function applyTheme() {
    var t = LS.get('theme', null);
    if (t) document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
  }
  function toggleTheme() {
    var cur = LS.get('theme', null);
    if (!cur) cur = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
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
  function toast(msg) {
    var t = el('<div class="toast" role="status">' + esc(msg) + '</div>');
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3200);
  }
  function stagePill(stageId) {
    var st = STAGE_BY_ID[stageId];
    var g = st.group === 'open' ? 'g-open' : st.group === 'won' ? 'g-won' : st.group === 'lost' ? 'g-lost' : 'g-unq';
    return '<span class="stage-pill ' + g + '"><i></i>' + esc(st.label) + '</span>';
  }
  function deltaHTML(cur, prev, label) {
    if (prev === 0 && cur === 0) return '<span>' + esc(label) + '</span>';
    var cls = cur >= prev ? 'up' : 'down';
    var sign = cur >= prev ? '+' : '−';
    var diff = Math.abs(cur - prev);
    return '<span class="' + cls + '">' + sign + fmtNum(diff) + '</span> ' + esc(label);
  }

  var ICONS = {
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
    '/dashboard':  { title: 'My Dashboard',      icon: 'dash',    render: viewDashboard, who: 'emp' },
    '/leads':      { title: 'My Leads',           icon: 'leads',   render: viewLeads,     who: 'emp' },
    '/submit':     { title: 'Submit a Lead',      icon: 'plus',    render: viewSubmit,    who: 'emp' },
    '/commission': { title: 'Commission',         icon: 'money',   render: viewCommission,who: 'emp' },
    '/stores':     { title: 'Top Zid Stores',     icon: 'store',   render: viewTopStores, who: 'all' },
    '/manager':    { title: 'Program Overview',   icon: 'manager', render: viewManager,   who: 'mgr' },
    '/performance':{ title: 'Hunter Performance', icon: 'trophy',  render: viewPerformance, who: 'mgr' },
    '/team':       { title: 'Team & Access',      icon: 'team',    render: viewTeam,      who: 'mgr' },
    '/settings':   { title: 'Program Settings',   icon: 'gear',    render: viewSettings,  who: 'mgr' },
    '/payouts':    { title: 'Commission Payouts', icon: 'money',   render: viewPayouts,   who: 'fin' },
    '/hunters':    { title: 'Hunter Profiles',    icon: 'person',  render: viewHunters,   who: 'fin' },
    '/profile':    { title: 'My Profile',         icon: 'person',  render: viewProfile,   who: 'emp' }
  };

  // Finance sees ONLY its own views; everyone else gets role + shared views
  function canAccess(who, role) {
    return role === 'fin' ? who === 'fin' : (who === 'all' || who === role);
  }

  function route() {
    var h = location.hash.replace(/^#/, '') || '/';
    if (!currentUser()) { renderLogin(); return; }
    var home = homeOf(roleOf());
    if (!ROUTES[h]) { location.hash = '#' + home; return; }
    var r = ROUTES[h];
    if (!canAccess(r.who, roleOf())) { location.hash = '#' + home; return; }
    renderShell(h, r);
  }

  /* ---------------- Login ---------------- */
  function renderLogin() {
    var users = usersAll().filter(function (u) { return u.active; });
    // hunters first (a handful), then management & finance
    var hunters = users.filter(function (u) { return u.role === 'emp'; });
    var staff = users.filter(function (u) { return u.role !== 'emp'; });
    var list = hunters.slice(0, 5).concat(hunters.slice(5).filter(function (u) { return String(u.id).charAt(0) === 'u'; }), staff);
    var personas = list.map(function (u) {
      var dark = u.role !== 'emp' ? ' style="background: var(--ink); color: var(--ground)"' : '';
      return '<button class="persona" data-login="' + esc(u.id) + '">' +
        '<span class="avatar"' + dark + '>' + esc(initials(u.name)) + '</span>' +
        '<span class="who"><b>' + esc(u.name) + '</b><span>' + esc(u.title || '') + ' · ' + esc(ROLE_NAMES[u.role]) + '</span></span>' +
        '<span class="go">→</span></button>';
    }).join('');

    var ps = statsFor(allLeads()); // program-wide, for the hero stats
    app.innerHTML =
      '<div class="login-wrap">' +
        '<div class="login-left"><div class="login-card">' +
          '<div class="brand">' + SH_MARK + '<div><b>Sales Hunter</b><small>Zid employee referral program</small></div></div>' +
          '<div class="card">' +
            '<h2>Sign in</h2>' +
            '<p class="sub">Pick a profile to explore the demo. In production this is Zid single sign-on.</p>' +
            '<div class="persona-list">' + personas + '</div>' +
          '</div>' +
          '<p class="login-note">Demo build · mock data · HubSpot is the system of record in production</p>' +
        '</div></div>' +
        '<div class="login-hero">' +
          HERO_RINGS +
          '<h2>Spot a merchant.<br>Bring them to Zid.<br>Take ' + ratePct() + ' of the win.</h2>' +
          '<p>Every lead you submit goes straight to the sales pipeline. Watch it move stage by stage — and the moment it closes won, your commission is locked in.</p>' +
          '<div class="hero-stats">' +
            '<div class="hero-stat"><b>' + fmtMoneyC(ps.commission) + '</b><span>earned by hunters so far</span></div>' +
            '<div class="hero-stat"><b>' + fmtNum(ps.won) + '</b><span>merchants brought to Zid</span></div>' +
            '<div class="hero-stat"><b>' + fmtPct(ps.conversion, 0) + '</b><span>of leads close won</span></div>' +
          '</div>' +
          '<div class="hero-zid">an internal program by ' + LOGO + '</div>' +
        '</div>' +
      '</div>';

    app.querySelectorAll('[data-login]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        LS.set('user', btn.getAttribute('data-login'));
        location.hash = '#' + homeOf(roleOf());
        route();
      });
    });
  }

  /* ---------------- Shell ---------------- */
  function renderShell(path, r) {
    var user = currentUser();
    var nav = Object.keys(ROUTES).filter(function (p) {
      return canAccess(ROUTES[p].who, roleOf());
    }).map(function (p) {
      return '<a href="#' + p + '" class="' + (p === path ? 'active' : '') + '">' + ICONS[ROUTES[p].icon] + esc(ROUTES[p].title) + '</a>';
    }).join('');

    app.innerHTML =
      '<div class="shell">' +
        '<aside class="sidebar">' +
          '<div class="brand">' + SH_MARK + '<div><b>Sales Hunter</b><small>by Zid · internal</small></div></div>' +
          '<nav class="nav">' + nav + '</nav>' +
          '<div class="side-foot">' +
            '<div class="userchip"><span class="avatar">' + esc(initials(user.name)) + '</span>' +
            '<span class="who"><b>' + esc(user.name) + '</b><span>' + esc(user.dept) + '</span></span></div>' +
            '<button class="link-btn" id="logout">Sign out</button>' +
          '</div>' +
        '</aside>' +
        '<div class="main">' +
          '<div class="topbar">' +
            '<div class="crumbs"><h1>' + esc(r.title) + '</h1><span class="demo-pill">Demo · mock data</span></div>' +
            '<div class="actions">' +
              '<button class="icon-btn" id="theme-toggle" title="Toggle light/dark" aria-label="Toggle theme">' + ICONS.sun + '</button>' +
            '</div>' +
          '</div>' +
          '<div class="content" id="content"></div>' +
          '<footer class="app-foot">Sales Hunter — an internal Zid program · demo with mock data · HubSpot becomes the backend in production</footer>' +
        '</div>' +
      '</div>';

    document.getElementById('logout').addEventListener('click', function () {
      LS.set('user', null); location.hash = ''; route();
    });
    document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

    var content = document.getElementById('content');
    r.render(content, user);
    initTooltip(content);
    wireCardToggles(content);
  }

  /* ================= Views ================= */

  function tile(label, value, deltaHtml) {
    return '<div class="tile"><div class="t-label">' + esc(label) + '</div>' +
      '<div class="t-value">' + value + '</div>' +
      (deltaHtml ? '<div class="t-delta">' + deltaHtml + '</div>' : '') + '</div>';
  }

  /* ---- Employee dashboard ---- */
  function viewDashboard(content, user) {
    var leads = leadsOf(user.id);
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

    var reasonsLost = Object.keys(s.lostReasons).map(function (k) { return { label: k, count: s.lostReasons[k] }; })
      .sort(function (a, b) { return b.count - a.count; });
    var reasonsUnq = Object.keys(s.unqualReasons).map(function (k) { return { label: k, count: s.unqualReasons[k] }; })
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
    if (bestCat && bestCat.wr > 0) tips.push('Your ' + bestCat.cat + ' leads convert best — ' + fmtPct(bestCat.wr, 0) + ' of them close won. Hunt more of these.');
    var topUnq = Object.keys(s.unqualReasons).sort(function (a, b) { return s.unqualReasons[b] - s.unqualReasons[a]; })[0];
    if (topUnq) tips.push('Your most common unqualified reason is “' + topUnq + '” — screen for this before submitting.');
    tips.push('Leads with notes on need and timing get qualified by pre-sales roughly twice as fast.');
    tips.push('Check Top Zid Stores for success stories to use in your pitch.');

    content.innerHTML =
      '<div class="welcome-banner">' +
        '<div><h2>Welcome back, ' + esc(user.name.split(' ')[0]) + '</h2>' +
        '<p class="w-date">' + NOW.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + ' · Hunter ID ' + hunterCode(user) + '</p></div>' +
        '<div class="w-chips">' +
          '<span class="wchip solid">' + esc(rank.current.name) + '</span>' +
          (rank.next ? '<span class="wchip">' + winsToNext + (winsToNext === 1 ? ' win' : ' wins') + ' to ' + esc(rank.next.name) + '</span>'
                     : '<span class="wchip">Top rank reached</span>') +
        '</div>' +
      '</div>' +

      '<div class="kpis">' +
        tile('Total leads', fmtNum(s.total), deltaHTML(leadsThisMonth, leadsLastMonth, 'vs last month')) +
        tile('Active pipeline', fmtNum(s.open), esc(fmtMoneyC(s.pipelineValue)) + ' potential value') +
        tile('Closed won', fmtNum(s.won), s.avgCycleDays ? s.avgCycleDays + ' days avg. cycle' : '') +
        tile('Closed lost', fmtNum(s.lost), '') +
        tile('Unqualified', fmtNum(s.unqualified), '') +
        tile('Conversion rate', fmtPct(s.conversion), 'closed won ÷ all submitted') +
        tile('Revenue generated', fmtMoneyC(s.revenueNet), 'subscription value, excl. VAT') +
        tile('Commission earned', '<span class="money-pos">' + fmtMoneyC(s.commission) + '</span>', fmtMoneyC(s.commissionPending + s.commissionApproved) + ' not yet paid') +
      '</div>' +

      '<div class="grid-2">' +
        '<section class="card">' +
          '<div class="card-head"><div><h3>Hunter level</h3><p class="sub">Level up by closing deals</p></div>' +
          '<span class="rank-pct">' + Math.round(rank.progress * 100) + '%</span></div>' +
          '<div class="rank-row"><b style="font-size:17px">' + esc(rank.current.name) + '</b></div>' +
          '<div class="rank-track"><div class="rank-fill" style="width:' + Math.max(4, Math.round(rank.progress * 100)) + '%"></div></div>' +
          '<p class="rank-next">' + (rank.next ? 'Next: <b>' + esc(rank.next.name) + '</b> at ' + rank.next.minWins + ' closed-won deals' : 'You hold the highest rank in the program.') + '</p>' +
          '<div class="rank-needs">' +
            '<div class="rank-need"><b>' + fmtNum(s.won) + '</b>deals won so far</div>' +
            (rank.next ? '<div class="rank-need"><b>' + winsToNext + '</b>more to level up</div>' : '') +
            '<div class="rank-need"><b>' + fmtNum(s.open) + '</b>chances in play</div>' +
          '</div>' +
        '</section>' +
        '<section class="card">' +
          '<div class="card-head"><div><h3>Sharpen your aim</h3><p class="sub">Reading your own numbers</p></div></div>' +
          '<div class="tips-list">' + tips.slice(0, 4).map(function (t) {
            return '<div class="tip-item"><span class="t-ico">›</span><span>' + esc(t) + '</span></div>';
          }).join('') + '</div>' +
        '</section>' +
      '</div>' +

      '<div class="grid-2">' +
        chartCard({
          title: 'Pipeline funnel', subtitle: 'How far your leads travel — count that reached each stage',
          svg: funnelSVG(s.funnel),
          table: { head: ['Stage', 'Leads reached'], rows: s.funnel.map(function (f) { return [f.stage, fmtNum(f.count)]; }) }
        }) +
        '<div>' +
          chartCard({
            title: 'Where your open leads are now', subtitle: fmtNum(s.open) + ' leads currently in play',
            svg: currentStages.length ? hbarsSVG(currentStages, { aria: 'Open leads by stage' }) : '<div class="empty">No open leads right now — submit a new one.</div>',
            table: { head: ['Stage', 'Leads'], rows: currentStages.map(function (c) { return [c.label, fmtNum(c.count)]; }) }
          }) +
          '<div style="height:16px"></div>' +
          chartCard({
            title: 'Outcome split', subtitle: 'All ' + fmtNum(s.total) + ' leads to date',
            legend: [{ cls: 'good', label: 'Won' }, { cls: 'critical', label: 'Lost' }, { cls: 'gray', label: 'Unqualified' }, { cls: 's1', label: 'Still open' }],
            svg: stackedBarSVG([
              { label: 'Closed won', count: s.won, cls: 'good' },
              { label: 'Closed lost', count: s.lost, cls: 'critical' },
              { label: 'Unqualified', count: s.unqualified, cls: 'gray' },
              { label: 'Still open', count: s.open, cls: 's1' }
            ]),
            table: { head: ['Outcome', 'Leads'], rows: [['Closed won', fmtNum(s.won)], ['Closed lost', fmtNum(s.lost)], ['Unqualified', fmtNum(s.unqualified)], ['Still open', fmtNum(s.open)]] }
          }) +
        '</div>' +
      '</div>' +

      '<div class="grid-2">' +
        chartCard({
          title: 'Leads submitted by month', subtitle: 'Last 12 months',
          svg: columnsSVG(months.map(function (m) { return m.label; }), byMonth, { aria: 'Leads by month', unit: 'leads' }),
          table: { head: ['Month', 'Leads'], rows: months.map(function (m, i) { return [m.label, fmtNum(byMonth[i])]; }) }
        }) +
        chartCard({
          title: 'Win rate of decided leads', subtitle: 'Won ÷ (won + lost + unqualified) closed in each month',
          svg: lineSVG(months.map(function (m) { return m.label; }), winRate, { pct: true, maxHint: 0.5, aria: 'Win rate trend', nullLabel: 'No leads decided this month' }),
          table: { head: ['Month', 'Win rate'], rows: months.map(function (m, i) { return [m.label, winRate[i] === null ? '—' : fmtPct(winRate[i], 0)]; }) }
        }) +
      '</div>' +

      '<div class="grid-2">' +
        chartCard({
          title: 'Why leads were lost', subtitle: 'Closed-lost reasons from the CRM (' + fmtNum(s.lost) + ' leads)',
          svg: hbarsSVG(reasonsLost, { aria: 'Lost reasons', cls: 'critical' }),
          table: { head: ['Reason', 'Leads'], rows: reasonsLost.map(function (x) { return [x.label, fmtNum(x.count)]; }) }
        }) +
        chartCard({
          title: 'Why leads were unqualified', subtitle: 'Learn what a strong lead looks like (' + fmtNum(s.unqualified) + ' leads)',
          svg: hbarsSVG(reasonsUnq, { aria: 'Unqualified reasons', cls: 'gray' }),
          table: { head: ['Reason', 'Leads'], rows: reasonsUnq.map(function (x) { return [x.label, fmtNum(x.count)]; }) }
        }) +
      '</div>';
  }

  /* ---- My Leads ---- */
  function viewLeads(content, user) {
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
          : (isOpen(l) && l.amountNet) ? '<span class="cell-sub">' + fmtMoneyC(l.amountNet * COMMISSION_RATE) + ' potential</span>' : '—';
        return '<tr class="rowlink" data-lead="' + l.id + '" tabindex="0">' +
          '<td><b>' + esc(l.company) + '</b><span class="cell-sub">' + esc(l.contact) + ' · ' + esc(l.city) + '</span></td>' +
          '<td>' + esc(l.industry) + '</td>' +
          '<td>' + fmtDate(l.createdAt) + '</td>' +
          '<td>' + stagePill(l.stage) + '</td>' +
          '<td>' + esc(l.salesOwner) + '</td>' +
          '<td>' + fmtDate(lastActivity(l)) + '</td>' +
          '<td class="num">' + (l.amountNet ? fmtMoneyC(l.amountNet) : '<span class="cell-sub">to be scoped</span>') +
            (l.plan ? '<span class="cell-sub">' + esc(l.plan) + (l.years === 2 ? ' · 2 yr' : '') + '</span>' : '') + '</td>' +
          '<td class="num">' + comm + '</td>' +
        '</tr>';
      }).join('');
      document.getElementById('leads-table').innerHTML =
        '<div class="tbl-wrap"><table>' +
          '<thead><tr><th>Merchant</th><th>Category</th><th>Submitted</th><th>Stage</th><th>Deal owner</th><th>Last activity</th><th class="num">Value (excl. VAT)</th><th class="num">Commission</th></tr></thead>' +
          '<tbody>' + (rows || '<tr><td colspan="8"><div class="empty">No leads match this filter.</div></td></tr>') + '</tbody>' +
        '</table></div>';
      document.querySelectorAll('[data-lead]').forEach(function (tr) {
        function open() { openDrawer(tr.getAttribute('data-lead')); }
        tr.addEventListener('click', open);
        tr.addEventListener('keydown', function (e) { if (e.key === 'Enter') open(); });
      });
    }

    var segStages = [['all', 'All'], ['open', 'Open'], ['won', 'Won'], ['lost', 'Lost'], ['unqualified', 'Unqualified']];
    content.innerHTML =
      '<div class="filter-row">' +
        '<div class="seg" id="stage-seg">' + segStages.map(function (s, i) {
          return '<button data-seg="' + s[0] + '" class="' + (i === 0 ? 'active' : '') + '">' + s[1] + '</button>';
        }).join('') + '</div>' +
        '<div class="spacer"></div>' +
        '<input type="text" class="search-input" id="lead-search" placeholder="Search company, contact, owner…">' +
        '<a href="#/submit" class="btn" style="text-decoration:none">+ Submit lead</a>' +
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
        '<b>' + esc(STAGE_BY_ID[e.stage].label) + '</b>' +
        '<span class="t-date">' + fmtDate(e.date) + '</span>' +
        '<p>' + esc(STAGE_STORY[e.stage] || '') + '</p></li>';
    }).join('');

    var commissionRow = '';
    if (lead.stage === 'won') {
      var cs = commissionStatus(lead);
      commissionRow =
        '<dt>Commission (' + ratePct() + ')</dt><dd class="money-pos">' + fmtMoney(commissionOf(lead)) +
        ' <span class="status-chip ' + cs + '">' + (cs === 'paid' ? 'Paid' : cs === 'approved' ? 'Approved' : 'Pending approval') + '</span></dd>';
    }
    var reasonRow = '';
    if (lead.stage === 'lost' && lead.lostReason) reasonRow = '<dt>Lost reason</dt><dd>' + esc(lead.lostReason) + '</dd>';
    if (lead.stage === 'unqualified' && lead.unqualReason) reasonRow = '<dt>Unqualified reason</dt><dd>' + esc(lead.unqualReason) + '</dd>';

    var root = el('<div id="drawer-root">' +
      '<div class="drawer-backdrop"></div>' +
      '<div class="drawer" role="dialog" aria-label="Lead detail">' +
        '<div class="d-head"><div><h2>' + esc(lead.company) + '</h2>' +
        '<p class="sub">' + esc(lead.contact) + ' · ' + esc(lead.industry) + ' · ' + esc(lead.city) + '</p></div>' +
        '<button class="icon-btn" id="drawer-close" aria-label="Close">✕</button></div>' +
        '<span class="hs-chip">⟳ Synced from HubSpot · deal ' + esc(lead.id) + '</span>' +
        '<dl class="d-kv">' +
          '<dt>Stage</dt><dd>' + stagePill(lead.stage) + '</dd>' +
          '<dt>Deal owner</dt><dd>' + esc(lead.salesOwner) + '</dd>' +
          (lead.plan ? '<dt>Package</dt><dd>Zid ' + esc(lead.plan) + (lead.years === 2 ? ' · 2 years' : ' · 1 year') + '</dd>' : '') +
          '<dt>Source</dt><dd>' + esc(lead.source) + '</dd>' +
          '<dt>Submitted</dt><dd>' + fmtDate(lead.createdAt) + '</dd>' +
          (lead.amountNet
            ? '<dt>Value (excl. VAT)</dt><dd>' + fmtMoney(lead.amountNet) + '</dd>' +
              '<dt>Value (incl. VAT)</dt><dd>' + fmtMoney(grossOf(lead)) + '</dd>'
            : '<dt>Value</dt><dd>To be scoped by sales</dd>') +
          commissionRow + reasonRow +
        '</dl>' +
        '<h3 class="eyebrow">Activity timeline</h3>' +
        '<ul class="timeline">' + timeline + '</ul>' +
      '</div></div>');
    document.body.appendChild(root);
    function close() { root.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    root.querySelector('.drawer-backdrop').addEventListener('click', close);
    root.querySelector('#drawer-close').addEventListener('click', close);
    document.addEventListener('keydown', onKey);
  }

  /* ---- Submit lead ---- */
  function viewSubmit(content, user) {
    content.innerHTML =
      '<div class="card" style="max-width:720px">' +
        '<h2>Submit a new lead</h2>' +
        '<p class="sub">Your merchant goes straight to the sales pipeline. In production this creates the contact and deal in HubSpot with you tagged as the hunter.</p>' +
        '<form id="lead-form" style="margin-top:16px">' +
          '<div class="form-grid">' +
            '<div><label class="f-label" for="f-company">Merchant / store name *</label><input type="text" id="f-company" required placeholder="e.g. Lulwa Boutique"></div>' +
            '<div><label class="f-label" for="f-industry">Store category *</label><select id="f-industry">' +
              INDUSTRIES.map(function (i) { return '<option>' + esc(i) + '</option>'; }).join('') + '</select></div>' +
            '<div><label class="f-label" for="f-contact">Contact person *</label><input type="text" id="f-contact" required placeholder="Full name"></div>' +
            '<div><label class="f-label" for="f-phone">Contact phone</label><input type="tel" id="f-phone" placeholder="+966 5X XXX XXXX"></div>' +
            '<div><label class="f-label" for="f-email">Contact email</label><input type="email" id="f-email" placeholder="name@store.com"></div>' +
            '<div><label class="f-label" for="f-city">City</label><select id="f-city">' +
              CITIES.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('') + '</select></div>' +
            '<div><label class="f-label" for="f-source">How do you know this merchant? *</label><select id="f-source">' +
              SOURCES.map(function (s) { return '<option>' + esc(s) + '</option>'; }).join('') + '</select></div>' +
            '<div><label class="f-label" for="f-plan">Likely package</label><select id="f-plan">' +
              '<option value="">Not sure — sales will scope it</option>' +
              PLANS.map(function (p) { return '<option value="' + p.price + '">Zid ' + esc(p.name) + ' — ' + fmtMoney(p.price) + ' / yr</option>'; }).join('') + '</select>' +
              '<p class="f-hint">Your commission is ' + ratePct() + ' of the final subscription value excl. VAT.</p></div>' +
            '<div class="full"><label class="f-label" for="f-notes">Why is this a good lead?</label>' +
              '<textarea id="f-notes" rows="3" placeholder="Context helps pre-sales qualify faster: what they sell, current channels (Instagram, WhatsApp…), timing, who decides."></textarea></div>' +
          '</div>' +
          '<div style="margin-top:16px; display:flex; gap:10px; align-items:center">' +
            '<button type="submit" class="btn">Submit lead</button>' +
            '<span class="sub">Duplicates are checked against the CRM before the deal is created.</span>' +
          '</div>' +
        '</form>' +
      '</div>';

    document.getElementById('lead-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var company = document.getElementById('f-company').value.trim();
      var contact = document.getElementById('f-contact').value.trim();
      if (!company || !contact) { toast('Company and contact person are required.'); return; }
      var planPrice = parseInt(document.getElementById('f-plan').value, 10);
      var plan = PLANS.find(function (p) { return p.price === planPrice; });
      // Anchor to the demo's frozen "today" so the lead lands inside every
      // monthly chart window (the whole dataset lives at NOW).
      var now = new Date(NOW.getTime());
      var leads = LS.get('leads', []);
      leads.unshift({
        id: 'L-N' + (1000 + leads.length + 1),
        hunterId: user.id,
        company: company,
        contact: contact,
        plan: plan ? plan.name : null,   // "Not sure" stays honest: no package
        years: 1,
        industry: document.getElementById('f-industry').value,
        city: document.getElementById('f-city').value,
        source: document.getElementById('f-source').value,
        createdAt: now.toISOString(),
        stage: 'new',
        events: [{ stage: 'new', date: now.toISOString() }],
        amountNet: plan ? plan.price : 0, // 0 = sales will scope it
        lostReason: null, unqualReason: null,
        salesOwner: 'Unassigned'
      });
      LS.set('leads', leads);
      toast('Lead submitted — it is now in the pipeline as “New Lead”.');
      location.hash = '#/leads';
    });
  }

  /* ---- Commission ---- */
  function viewCommission(content, user) {
    var leads = leadsOf(user.id);
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
          '<div class="card-head"><div><h3>How your commission is calculated</h3>' +
          '<p class="sub">Example: your latest won deal — ' + esc(example.company) + '</p></div></div>' +
          '<div class="math-steps">' +
            '<div class="math-step"><div class="m-label">Subscription incl. VAT</div><div class="m-value">' + fmtMoney(grossOf(example)) + '</div><div class="m-note">what the customer pays</div></div>' +
            '<div class="math-step"><div class="m-label">Remove ' + vatPct() + ' VAT (÷ ' + (1 + VAT_RATE).toFixed(2) + ')</div><div class="m-value">' + fmtMoney(example.amountNet) + '</div><div class="m-note">net subscription value</div></div>' +
            '<div class="math-step result"><div class="m-label">Your commission (× ' + ratePct() + ')</div><div class="m-value">' + fmtMoney(commissionOf(example)) + '</div><div class="m-note">paid with next payroll after approval</div></div>' +
          '</div>' +
        '</section>';
    }

    var histRows = wonLeads.map(function (l) {
      var cs = commissionStatus(l);
      return '<tr>' +
        '<td><b>' + esc(l.company) + '</b><span class="cell-sub">deal ' + esc(l.id) + '</span></td>' +
        '<td>' + fmtDate(wonDate(l)) + '</td>' +
        '<td class="num">' + fmtMoney(l.amountNet) + '</td>' +
        '<td class="num"><b>' + fmtMoney(commissionOf(l)) + '</b></td>' +
        '<td><span class="status-chip ' + cs + '">' + (cs === 'paid' ? 'Paid' : cs === 'approved' ? 'Approved' : 'Pending approval') + '</span>' +
          (cs === 'paid' && getSlips()[l.id] ? '<span class="cell-sub">' + slipLink(l.id) + '</span>' : '') + '</td>' +
      '</tr>';
    }).join('');

    content.innerHTML =
      '<div class="card" style="display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:14px">' +
        '<div><span class="eyebrow">Lifetime commission earned</span>' +
        '<div class="hero-figure money-pos">' + fmtMoney(s.commission) + '</div>' +
        '<p class="sub">from ' + fmtNum(s.won) + ' closed-won deals · ' + fmtMoneyC(s.revenueNet) + ' revenue generated for the company</p></div>' +
        '<button class="btn secondary" id="dl-statement">Download statement (CSV)</button>' +
      '</div>' +

      '<div class="kpis">' +
        tile('This month', fmtMoneyC(commInMonth(thisMonthKey)), '') +
        tile('Last month', fmtMoneyC(commInMonth(lastMonthKey)), '') +
        tile('Pending approval', fmtMoneyC(s.commissionPending), 'awaiting finance review') +
        tile('Approved — next payroll', fmtMoneyC(s.commissionApproved), '') +
        tile('Paid to date', fmtMoneyC(s.commissionPaid), '') +
      '</div>' +

      mathCard +

      chartCard({
        title: 'Revenue you generated vs. commission earned', subtitle: 'By month the deal closed won · both excl. VAT',
        legend: [{ cls: 's1', label: 'Revenue generated' }, { cls: 's2', label: 'Your commission (' + ratePct() + ')' }],
        svg: groupedColumnsSVG(months.map(function (m) { return m.label; }), revByMonth, commByMonth,
          { nameA: 'Revenue generated', nameB: 'Your commission', aria: 'Revenue vs commission', W: 1080 }),
        table: { head: ['Month', 'Revenue (SAR)', 'Commission (SAR)'], rows: months.map(function (m, i) { return [m.label, fmtNum(revByMonth[i]), fmtNum(commByMonth[i])]; }) }
      }) +

      '<section class="card">' +
        '<div class="card-head"><div><h3>Commission history</h3><p class="sub">One row per closed-won deal</p></div></div>' +
        '<div class="tbl-wrap"><table>' +
          '<thead><tr><th>Deal</th><th>Closed won</th><th class="num">Value (excl. VAT)</th><th class="num">Commission</th><th>Status</th></tr></thead>' +
          '<tbody>' + (histRows || '<tr><td colspan="5"><div class="empty">No closed-won deals yet — your first one unlocks this table.</div></td></tr>') + '</tbody>' +
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
      toast('Statement downloaded.');
    });
  }

  /* ---- Leaderboard ---- */
  function badgesFor(empId, s, topThisMonth) {
    var out = [];
    if (s.won >= 1) out.push('🏆 First sale');
    if (s.won >= 5) out.push('🔥 5 wins');
    if (s.revenueNet >= 500000) out.push('💎 SAR 500K generated');
    if (topThisMonth === empId) out.push('🚀 Top hunter this month');
    if (s.total >= 10 && s.unqualified / s.total < 0.1) out.push('🎯 Sharp eye');
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

  /* Management-only ranking (replaces the shared leaderboard — hunters
     see only their own numbers, for privacy) */
  function viewPerformance(content) {
    var data = leaderboardData();
    var rows = data.rows.sort(function (a, b) { return b.s.revenueNet - a.s.revenueNet; });
    var maxRev = Math.max.apply(null, rows.map(function (r) { return r.s.revenueNet; }).concat([1]));

    var body = rows.map(function (r, i) {
      var rankCls = i === 0 ? 'top1' : i === 1 ? 'top2' : i === 2 ? 'top3' : '';
      var badges = badgesFor(r.emp.id, r.s, data.topThisMonthId);
      return '<tr>' +
        '<td><span class="rank-badge ' + rankCls + '">' + (i + 1) + '</span></td>' +
        '<td><b>' + esc(r.emp.name) + '</b><span class="cell-sub">' + esc(r.emp.dept) + '</span></td>' +
        '<td class="num">' + fmtNum(r.s.total) + '</td>' +
        '<td class="num">' + fmtNum(r.s.won) + '</td>' +
        '<td class="num">' + fmtPct(r.s.conversion, 0) + '</td>' +
        '<td style="min-width:120px"><div class="progress-track"><div class="progress-fill" style="width:' + Math.round(r.s.revenueNet / maxRev * 100) + '%"></div></div></td>' +
        '<td class="num"><b>' + fmtMoneyC(r.s.revenueNet) + '</b></td>' +
        '<td class="num">' + fmtMoneyC(r.s.commission) + '</td>' +
        '<td><div class="badges">' + badges.map(function (b) { return '<span class="badge-chip">' + esc(b) + '</span>'; }).join('') + '</div></td>' +
      '</tr>';
    }).join('');

    content.innerHTML =
      '<section class="card">' +
        '<div class="card-head"><div><h3>All-time ranking</h3>' +
        '<p class="sub">Ranked by revenue generated (closed-won, excl. VAT) — visible to management only; hunters see just their own numbers</p></div></div>' +
        '<div class="tbl-wrap"><table>' +
          '<thead><tr><th></th><th>Hunter</th><th class="num">Leads</th><th class="num">Won</th><th class="num">Conversion</th><th>Revenue</th><th class="num"></th><th class="num">Commission</th><th>Achievements</th></tr></thead>' +
          '<tbody>' + body + '</tbody>' +
        '</table></div>' +
      '</section>';
  }

  /* ---- Management backoffice: team & access ---- */
  function viewTeam(content, user) {
    function saveOverride(id, patch) {
      var over = LS.get('userOverrides', {});
      over[id] = Object.assign(over[id] || {}, patch);
      LS.set('userOverrides', over);
    }

    function render() {
      var users = usersAll();
      var rows = users.map(function (u) {
        var isSelf = u.id === user.id;
        return '<tr>' +
          '<td><b>' + esc(u.name) + (isSelf ? ' · you' : '') + '</b><span class="cell-sub">' + esc(u.title || '') + '</span></td>' +
          '<td>' + esc(u.dept || '—') + '</td>' +
          '<td>' + esc(u.email || '—') + '</td>' +
          '<td>' + (isSelf
            ? '<span class="cat-chip">' + ROLE_NAMES[u.role] + '</span>'
            : '<select class="status-select role-select" data-user="' + esc(u.id) + '">' +
                ['emp', 'mgr', 'fin'].map(function (r) {
                  return '<option value="' + r + '"' + (r === u.role ? ' selected' : '') + '>' + ROLE_NAMES[r] + '</option>';
                }).join('') + '</select>') + '</td>' +
          '<td>' + (u.active
            ? '<span class="status-chip paid">Active</span>'
            : '<span class="status-chip pending">Disabled</span>') + '</td>' +
          '<td>' + (isSelf ? '' : '<button class="ghost-btn toggle-active" data-user="' + esc(u.id) + '">' + (u.active ? 'Disable' : 'Enable') + '</button>') + '</td>' +
        '</tr>';
      }).join('');

      content.innerHTML =
        '<div class="filter-row">' +
          '<div><h2>Team & access</h2><p class="sub">' + users.filter(function (u) { return u.active; }).length + ' active users · roles control what each person sees</p></div>' +
          '<div class="spacer"></div>' +
          '<button class="btn" id="add-user-btn">+ Add user</button>' +
        '</div>' +
        '<div class="card" id="add-user-card" hidden>' +
          '<h3>Add a user</h3>' +
          '<form id="add-user-form" style="margin-top:12px">' +
            '<div class="form-grid">' +
              '<div><label class="f-label" for="nu-name">Full name *</label><input type="text" id="nu-name" required></div>' +
              '<div><label class="f-label" for="nu-email">Company email *</label><input type="email" id="nu-email" required placeholder="name@zid.sa"></div>' +
              '<div><label class="f-label" for="nu-dept">Department</label><input type="text" id="nu-dept" placeholder="e.g. Marketing"></div>' +
              '<div><label class="f-label" for="nu-title">Job title</label><input type="text" id="nu-title"></div>' +
              '<div><label class="f-label" for="nu-role">Role *</label><select id="nu-role">' +
                '<option value="emp">Hunter</option><option value="mgr">Management</option><option value="fin">Finance</option>' +
              '</select><p class="f-hint">In production this sends an SSO invite instead of creating a login.</p></div>' +
            '</div>' +
            '<div style="margin-top:14px; display:flex; gap:10px">' +
              '<button type="submit" class="btn">Create user</button>' +
              '<button type="button" class="btn secondary" id="add-user-cancel">Cancel</button>' +
            '</div>' +
          '</form>' +
        '</div>' +
        '<section class="card">' +
          '<div class="tbl-wrap"><table>' +
            '<thead><tr><th>User</th><th>Department</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead>' +
            '<tbody>' + rows + '</tbody>' +
          '</table></div>' +
        '</section>' +
        '<p class="sub" style="text-align:center">You cannot change or disable your own account. Disabled users keep their history but can no longer sign in.</p>';

      document.getElementById('add-user-btn').addEventListener('click', function () {
        document.getElementById('add-user-card').hidden = false;
      });
      document.getElementById('add-user-cancel').addEventListener('click', function () {
        document.getElementById('add-user-card').hidden = true;
      });
      document.getElementById('add-user-form').addEventListener('submit', function (e) {
        e.preventDefault();
        var name = document.getElementById('nu-name').value.trim();
        var email = document.getElementById('nu-email').value.trim();
        if (!name || !email) return;
        var custom = LS.get('users', []);
        custom.push({
          id: 'u' + (100 + custom.length),
          name: name, email: email,
          dept: document.getElementById('nu-dept').value.trim() || 'General',
          title: document.getElementById('nu-title').value.trim() || ROLE_NAMES[document.getElementById('nu-role').value],
          role: document.getElementById('nu-role').value,
          code: String(8681849300 + custom.length)
        });
        LS.set('users', custom);
        audit('Added user ' + name + ' (' + ROLE_NAMES[document.getElementById('nu-role').value] + ')');
        toast(name + ' added — they now appear on the sign-in screen.');
        render();
      });
      content.querySelectorAll('.role-select').forEach(function (sel) {
        sel.addEventListener('change', function () {
          var u = usersAll().find(function (x) { return x.id === sel.getAttribute('data-user'); });
          saveOverride(sel.getAttribute('data-user'), { role: sel.value });
          audit('Changed role of ' + (u ? u.name : sel.getAttribute('data-user')) + ' to ' + ROLE_NAMES[sel.value]);
          toast('Role updated to ' + ROLE_NAMES[sel.value] + '.');
          render();
        });
      });
      content.querySelectorAll('.toggle-active').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-user');
          var u = usersAll().find(function (x) { return x.id === id; });
          saveOverride(id, { active: !u.active });
          audit((u.active ? 'Disabled ' : 'Enabled ') + u.name);
          toast(u.name + (u.active ? ' disabled.' : ' enabled.'));
          render();
        });
      });
    }
    render();
  }

  /* ---- Management backoffice: program settings + audit log ---- */
  function viewSettings(content) {
    var log = LS.get('audit', []);
    content.innerHTML =
      '<div class="grid-2">' +
        '<section class="card">' +
          '<div class="card-head"><div><h3>Commission rules</h3>' +
          '<p class="sub">Changes apply instantly across every dashboard (demo)</p></div></div>' +
          '<form id="settings-form"><div class="form-grid">' +
            '<div><label class="f-label" for="set-rate">Hunter commission (% of net)</label>' +
              '<input type="number" id="set-rate" min="1" max="50" step="0.5" value="' + (COMMISSION_RATE * 100) + '">' +
              '<p class="f-hint">Currently ' + ratePct() + ' of subscription value excl. VAT</p></div>' +
            '<div><label class="f-label" for="set-vat">VAT rate (%)</label>' +
              '<input type="number" id="set-vat" min="0" max="30" step="1" value="' + (VAT_RATE * 100) + '">' +
              '<p class="f-hint">KSA standard is 15% — deals with other VAT read it from HubSpot in production</p></div>' +
          '</div>' +
          '<div style="margin-top:14px"><button type="submit" class="btn">Save rules</button></div></form>' +
        '</section>' +
        '<section class="card">' +
          '<div class="card-head"><div><h3>Demo controls</h3><p class="sub">For presentations</p></div></div>' +
          '<p class="sub" style="margin-bottom:12px">Reset clears everything done in this browser — submitted leads, payment status changes, payslips, added users, and settings — back to the original mock data.</p>' +
          '<button class="btn secondary" id="reset-demo">Reset demo data</button>' +
        '</section>' +
      '</div>' +
      '<section class="card">' +
        '<div class="card-head"><div><h3>Audit log</h3><p class="sub">Sensitive actions in this browser session — in production every payout, role change, and IBAN view lands here</p></div></div>' +
        (log.length
          ? '<div class="tbl-wrap"><table class="mini"><thead><tr><th>When</th><th>Who</th><th>Action</th></tr></thead><tbody>' +
            log.map(function (e) {
              return '<tr><td>' + fmtDate(new Date(e.at)) + '<span class="cell-sub">' + new Date(e.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + '</span></td>' +
                '<td>' + esc(e.who) + '</td><td>' + esc(e.action) + '</td></tr>';
            }).join('') + '</tbody></table></div>'
          : '<div class="empty">Nothing yet — payment status changes, payslip uploads, and team edits will appear here.</div>') +
      '</section>';

    document.getElementById('settings-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var rate = parseFloat(document.getElementById('set-rate').value);
      var vat = parseFloat(document.getElementById('set-vat').value);
      if (isNaN(rate) || rate <= 0 || rate > 50 || isNaN(vat) || vat < 0 || vat > 30) {
        toast('Enter a commission between 1–50% and VAT between 0–30%.');
        return;
      }
      COMMISSION_RATE = rate / 100;
      VAT_RATE = vat / 100;
      LS.set('settings', { commissionRate: COMMISSION_RATE, vatRate: VAT_RATE });
      audit('Set commission to ' + rate + '% and VAT to ' + vat + '%');
      toast('Rules saved — commission is now ' + ratePct() + ' everywhere.');
      route();
    });
    document.getElementById('reset-demo').addEventListener('click', function () {
      ['leads', 'paystatus', 'payslips', 'users', 'userOverrides', 'settings', 'audit'].forEach(function (k) {
        try { localStorage.removeItem('sh.' + k); } catch (e) {}
      });
      EMPLOYEES.forEach(function (emp) { try { localStorage.removeItem('sh.profile.' + emp.id); } catch (e) {} });
      Object.keys(COMMISSION_STATUS_OVERRIDES).forEach(function (k) { delete COMMISSION_STATUS_OVERRIDES[k]; });
      COMMISSION_RATE = 0.20; VAT_RATE = 0.15;
      toast('Demo reset to original mock data.');
      route();
    });
  }

  /* ---- Top Zid stores: categories first, drill into each ---- */
  function viewTopStores(content, user) {
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
      content.innerHTML =
        '<div class="card" style="display:flex; justify-content:space-between; gap:14px; flex-wrap:wrap; align-items:center">' +
          '<div><h2>The stores winning on Zid right now</h2>' +
          '<p class="sub">Pick a category to see its top performers — proof points for your pitch: “stores like yours do this on Zid.”</p></div>' +
        '</div>' +
        '<div class="store-grid">' +
        STORE_SHOWCASE.map(function (c, i) {
          var wr = winRateOf(c.category);
          var mine = mineByCat[c.category] || 0;
          var leader = c.stores[0];
          return '<button class="card store-card cat-card" data-cat="' + i + '">' +
            '<div class="s-cat"><span class="cat-chip">' + esc(c.category) + '</span>' +
            (wr !== null ? '<span class="s-city" title="Program-wide win rate of decided leads in this category">' + fmtPct(wr, 0) + ' win rate</span>' : '') + '</div>' +
            '<div><h3>№1 · ' + esc(leader.name) + '</h3><span class="s-city">' + esc(leader.city) + ' · ' + fmtNum(leader.ordersMo) + ' orders / month</span></div>' +
            '<p class="s-blurb">' + c.stores.length + ' top ' + (c.stores.length === 1 ? 'store' : 'stores') + ' to use in your pitch' +
              (mine ? ' · <span class="s-mine">you have ' + mine + (mine === 1 ? ' lead' : ' leads') + ' here</span>' : '') + '</p>' +
            '<span class="s-open">Browse category →</span>' +
          '</button>';
        }).join('') +
        '</div>';
      content.querySelectorAll('[data-cat]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          renderCategory(STORE_SHOWCASE[parseInt(btn.getAttribute('data-cat'), 10)]);
          window.scrollTo(0, 0);
        });
      });
    }

    function renderCategory(c) {
      var wr = winRateOf(c.category);
      var mine = mineByCat[c.category] || 0;
      content.innerHTML =
        '<div class="filter-row">' +
          '<button class="ghost-btn" id="back-cats">← All categories</button>' +
        '</div>' +
        '<div class="card" style="display:flex; justify-content:space-between; gap:14px; flex-wrap:wrap; align-items:center">' +
          '<div><h2>' + esc(c.category) + '</h2>' +
          '<p class="sub">Top Zid stores in this category' +
            (wr !== null ? ' · hunter leads here close won ' + fmtPct(wr, 0) + ' of the time' : '') +
            (mine ? ' · you have ' + mine + (mine === 1 ? ' lead' : ' leads') + ' in this category' : '') + '</p></div>' +
        '</div>' +
        '<div class="store-grid">' +
        c.stores.map(function (t, i) {
          return '<section class="card store-card">' +
            '<div class="s-cat"><span class="rank-badge ' + (i === 0 ? 'top1' : i === 1 ? 'top2' : i === 2 ? 'top3' : '') + '">' + (i + 1) + '</span>' +
            '<span class="s-city">' + esc(t.city) + '</span></div>' +
            '<div><h3>' + esc(t.name) + '</h3></div>' +
            '<div class="s-metrics">' +
              '<div class="s-metric"><b>' + fmtNum(t.ordersMo) + '</b><span>orders / month</span></div>' +
              '<div class="s-metric"><b class="money-pos">+' + Math.round(t.growth * 100) + '%</b><span>growth this year</span></div>' +
            '</div>' +
            '<p class="s-blurb">' + esc(t.blurb) + '</p>' +
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
      if (!prev) return '<span class="mom-up">new</span>';
      var ch = (cur - prev) / prev;
      var cls = ch >= 0 ? 'mom-up' : 'mom-down';
      return '<span class="' + cls + '">' + (ch >= 0 ? '▲' : '▼') + ' ' + Math.abs(Math.round(ch * 100)) + '%</span>';
    }
    var momRows = [
      ['Leads submitted', fmtNum(mThis.leads), fmtNum(mLast.leads), momDelta(mThis.leads, mLast.leads)],
      ['New Zid stores (won)', fmtNum(mThis.won), fmtNum(mLast.won), momDelta(mThis.won, mLast.won)],
      ['Revenue closed', fmtMoneyC(mThis.revenue), fmtMoneyC(mLast.revenue), momDelta(mThis.revenue, mLast.revenue)],
      ['Commission unlocked', fmtMoneyC(mThis.commission), fmtMoneyC(mLast.commission), momDelta(mThis.commission, mLast.commission)]
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
    var STAGE_SHORT = { new: 'New', prospect: 'Prospect', qualified: 'Qualified', sql: 'SQL', commit: 'Commit', reengage: 'Re-engage' };
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

    var reasonsLost = Object.keys(s.lostReasons).map(function (k) { return { label: k, count: s.lostReasons[k] }; })
      .sort(function (a, b) { return b.count - a.count; });
    var reasonsUnq = Object.keys(s.unqualReasons).map(function (k) { return { label: k, count: s.unqualReasons[k] }; })
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
        tile('Active hunters', fmtNum(participants), 'of ' + EMPLOYEES.length + ' enrolled') +
        tile('Total leads', fmtNum(s.total), fmtNum(s.open) + ' currently open') +
        tile('New Zid stores', fmtNum(s.won), (s.avgCycleDays ? s.avgCycleDays + ' days avg. cycle' : 'closed-won merchants')) +
        tile('Program conversion', fmtPct(s.conversion), 'closed won ÷ all submitted') +
        tile('Revenue closed', fmtMoneyC(s.revenueNet), s.won ? fmtMoneyC(s.revenueNet / s.won) + ' avg per store · excl. VAT' : 'excl. VAT') +
        tile('Pipeline value', fmtMoneyC(s.pipelineValue), 'open deals, excl. VAT') +
        tile('Commission owed + paid', fmtMoneyC(s.commission), fmtMoneyC(s.commissionPaid) + ' already paid') +
        tile('Forecast from pipeline', fmtMoneyC(forecast), 'open deals × stage probability') +
      '</div>' +

      '<div class="grid-2">' +
        '<section class="card">' +
          '<div class="card-head"><div><h3>This month vs last month</h3>' +
          '<p class="sub">' + NOW.toLocaleString('en', { month: 'long' }) + ' month-to-date (day ' + NOW.getDate() + ') vs full ' + new Date(NOW.getFullYear(), NOW.getMonth() - 1, 1).toLocaleString('en', { month: 'long' }) + '</p></div></div>' +
          '<div class="tbl-wrap"><table class="mini">' +
            '<thead><tr><th>Metric</th><th class="num">This month</th><th class="num">Last month</th><th class="num">Change</th></tr></thead>' +
            '<tbody>' + momRows.map(function (r) {
              return '<tr><td>' + r[0] + '</td><td class="num"><b>' + r[1] + '</b></td><td class="num">' + r[2] + '</td><td class="num">' + r[3] + '</td></tr>';
            }).join('') + '</tbody>' +
          '</table></div>' +
        '</section>' +
        '<section class="card">' +
          '<div class="card-head"><div><h3>Top packages sold</h3><p class="sub">Closed-won deals by Zid plan · share of revenue</p></div></div>' +
          '<div class="legend">' + PLANS.map(function (p) {
            return '<span class="lg"><i class="sw ' + PLAN_CLS[p.name] + '"></i>' + esc(p.name) + '</span>';
          }).join('') + '</div>' +
          stackedBarSVG(PLANS.map(function (p) {
            return { label: 'Zid ' + p.name, count: planAgg[p.name].revenue, cls: PLAN_CLS[p.name] };
          }), { money: true, aria: 'Revenue share by package' }) +
          '<div class="tbl-wrap"><table class="mini">' +
            '<thead><tr><th>Package</th><th class="num">Stores</th><th class="num">Revenue</th><th class="num">Share</th></tr></thead>' +
            '<tbody>' + PLANS.map(function (p) {
              var a = planAgg[p.name];
              return '<tr><td>Zid ' + esc(p.name) + '</td><td class="num">' + fmtNum(a.count) + '</td><td class="num"><b>' + fmtMoneyC(a.revenue) + '</b></td><td class="num">' + fmtPct(a.revenue / planRevTotal, 0) + '</td></tr>';
            }).join('') + '</tbody>' +
          '</table></div>' +
        '</section>' +
      '</div>' +

      '<div class="grid-2">' +
        chartCard({
          title: 'Program funnel', subtitle: 'All hunter leads — count that reached each stage',
          svg: funnelSVG(s.funnel),
          table: { head: ['Stage', 'Leads reached'], rows: s.funnel.map(function (f) { return [f.stage, fmtNum(f.count)]; }) }
        }) +
        '<section class="card">' +
          '<div class="card-head"><div><h3>Deals by stage right now</h3>' +
          '<p class="sub">Live count in each pipeline stage — mirrors the HubSpot board</p></div></div>' +
          '<div class="tbl-wrap"><table class="mini">' +
            '<thead><tr><th>Stage</th><th class="num">Deals</th><th class="num">Value (excl. VAT)</th></tr></thead>' +
            '<tbody>' + stageNowRows + '</tbody>' +
          '</table></div>' +
        '</section>' +
      '</div>' +

      '<div class="grid-2">' +
        '<section class="card">' +
          '<div class="card-head"><div><h3>Outcome split</h3><p class="sub">All ' + fmtNum(s.total) + ' leads to date</p></div></div>' +
          '<div class="legend">' +
            '<span class="lg"><i class="sw good"></i>Won</span><span class="lg"><i class="sw critical"></i>Lost</span>' +
            '<span class="lg"><i class="sw gray"></i>Unqualified</span><span class="lg"><i class="sw s1"></i>Still open</span>' +
          '</div>' +
          stackedBarSVG([
            { label: 'Closed won', count: s.won, cls: 'good' },
            { label: 'Closed lost', count: s.lost, cls: 'critical' },
            { label: 'Unqualified', count: s.unqualified, cls: 'gray' },
            { label: 'Still open', count: s.open, cls: 's1' }
          ]) +
          '<div class="tbl-wrap"><table class="mini">' +
            '<thead><tr><th>Outcome</th><th class="num">Leads</th><th class="num">Amount</th></tr></thead>' +
            '<tbody>' +
              '<tr><td>Closed won</td><td class="num"><b>' + fmtNum(s.won) + '</b></td><td class="num"><b class="money-pos">' + fmtMoneyC(s.revenueNet) + '</b> revenue</td></tr>' +
              '<tr><td>Still open</td><td class="num"><b>' + fmtNum(s.open) + '</b></td><td class="num">' + fmtMoneyC(s.pipelineValue) + ' in play</td></tr>' +
              '<tr><td>Closed lost</td><td class="num"><b>' + fmtNum(s.lost) + '</b></td><td class="num">—</td></tr>' +
              '<tr><td>Unqualified</td><td class="num"><b>' + fmtNum(s.unqualified) + '</b></td><td class="num">—</td></tr>' +
            '</tbody>' +
          '</table></div>' +
        '</section>' +
        chartCard({
          title: 'Leads submitted by month', subtitle: 'Program-wide, last 12 months',
          svg: columnsSVG(months.map(function (m) { return m.label; }), byMonth, { aria: 'Program leads by month' }),
          table: { head: ['Month', 'Leads'], rows: months.map(function (m, i) { return [m.label, fmtNum(byMonth[i])]; }) }
        }) +
      '</div>' +

      '<section class="card">' +
        '<div class="card-head"><div><h3>Sales rep performance on hunter leads</h3>' +
        '<p class="sub">How each rep handles the leads hunters bring — win rate is over decided leads (won + lost + unqualified)</p></div></div>' +
        '<div class="tbl-wrap"><table>' +
          '<thead><tr><th>Sales rep</th><th class="num">Hunter leads</th><th class="num">Won</th><th class="num">Lost</th><th class="num">Unqualified</th><th class="num">Win rate</th><th class="num">Revenue won</th><th>Open pipeline now</th></tr></thead>' +
          '<tbody>' + repRows.map(function (row) {
            var r = row.r;
            var stageBits = Object.keys(r.stages).map(function (sid) {
              return r.stages[sid] + ' ' + (STAGE_SHORT[sid] || sid);
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
          title: 'Revenue closed by month', subtitle: 'Closed-won subscription value, excl. VAT',
          svg: columnsSVG(months.map(function (m) { return m.label; }), revByMonth, { money: true, compact: true, aria: 'Revenue by month' }),
          table: { head: ['Month', 'Revenue (SAR)'], rows: months.map(function (m, i) { return [m.label, fmtNum(revByMonth[i])]; }) }
        }) +
        '<section class="card">' +
          '<div class="card-head"><div><h3>Department comparison</h3><p class="sub">Which teams hunt best</p></div></div>' +
          '<div class="tbl-wrap"><table class="mini">' +
            '<thead><tr><th>Department</th><th class="num">Leads</th><th class="num">Won</th><th class="num">Revenue</th></tr></thead>' +
            '<tbody>' + deptRows.map(function (d) {
              return '<tr><td>' + esc(d.label) + '</td><td class="num">' + fmtNum(d.count) + '</td><td class="num">' + fmtNum(d.won) + '</td><td class="num"><b>' + fmtMoneyC(d.revenue) + '</b></td></tr>';
            }).join('') + '</tbody>' +
          '</table></div>' +
        '</section>' +
      '</div>' +

      '<div class="grid-2">' +
        '<section class="card">' +
          '<div class="card-head"><div><h3>Lead source performance</h3><p class="sub">Wins by how the hunter knows the lead · win rate of decided leads</p></div></div>' +
          '<div class="tbl-wrap"><table class="mini">' +
            '<thead><tr><th>Source</th><th class="num">Leads</th><th class="num">Won</th><th class="num">Win rate</th></tr></thead>' +
            '<tbody>' + srcRows.map(function (r) {
              return '<tr><td>' + esc(r.label) + '</td><td class="num">' + fmtNum(r.total) + '</td><td class="num">' + fmtNum(r.count) + '</td><td class="num">' + (r.decided >= 3 ? fmtPct(r.count / r.decided, 0) : '—') + '</td></tr>';
            }).join('') + '</tbody>' +
          '</table></div>' +
        '</section>' +
        chartCard({
          title: 'Top closed-lost reasons', subtitle: 'Program-wide (' + fmtNum(s.lost) + ' lost leads)',
          svg: hbarsSVG(reasonsLost.slice(0, 6), { aria: 'Program lost reasons', cls: 'critical' }),
          table: { head: ['Reason', 'Leads'], rows: reasonsLost.map(function (x) { return [x.label, fmtNum(x.count)]; }) }
        }) +
      '</div>' +

      '<div class="grid-2">' +
        chartCard({
          title: 'Why leads were unqualified', subtitle: 'Program-wide (' + fmtNum(s.unqualified) + ' unqualified leads)',
          svg: hbarsSVG(reasonsUnq.slice(0, 6), { aria: 'Program unqualified reasons', cls: 'gray' }),
          table: { head: ['Reason', 'Leads'], rows: reasonsUnq.map(function (x) { return [x.label, fmtNum(x.count)]; }) }
        }) +
        '<section class="card">' +
          '<div class="card-head"><div><h3>Where the wins come from</h3><p class="sub">Closed-won stores by category</p></div></div>' +
          '<div class="tbl-wrap"><table class="mini">' +
            '<thead><tr><th>Category</th><th class="num">Stores</th><th class="num">Revenue</th><th class="num">Avg deal</th></tr></thead>' +
            '<tbody>' + (catRows.length ? catRows.map(function (c) {
              return '<tr><td>' + esc(c.label) + '</td><td class="num">' + fmtNum(c.count) + '</td><td class="num"><b>' + fmtMoneyC(c.revenue) + '</b></td><td class="num">' + fmtMoneyC(c.revenue / c.count) + '</td></tr>';
            }).join('') : '<tr><td colspan="4"><div class="empty">No closed-won stores yet.</div></td></tr>') + '</tbody>' +
          '</table></div>' +
        '</section>' +
      '</div>' +

      '<div class="grid-2">' +
        '<section class="card">' +
          '<div class="card-head"><div><h3>Commission payout status</h3><p class="sub">For finance — where every riyal of commission stands</p></div></div>' +
          '<div class="tbl-wrap"><table class="mini">' +
            '<thead><tr><th>Status</th><th class="num">Amount</th></tr></thead>' +
            '<tbody>' +
              '<tr><td><span class="status-chip pending">Pending approval</span></td><td class="num"><b>' + fmtMoney(s.commissionPending) + '</b></td></tr>' +
              '<tr><td><span class="status-chip approved">Approved — next payroll</span></td><td class="num"><b>' + fmtMoney(s.commissionApproved) + '</b></td></tr>' +
              '<tr><td><span class="status-chip paid">Paid to date</span></td><td class="num"><b>' + fmtMoney(s.commissionPaid) + '</b></td></tr>' +
              '<tr><td>Total commission (' + ratePct() + ' of net)</td><td class="num"><b>' + fmtMoney(s.commission) + '</b></td></tr>' +
            '</tbody>' +
          '</table></div>' +
        '</section>' +
        '<section class="card">' +
          '<div class="card-head"><div><h3>Hunters who may need coaching</h3>' +
          '<p class="sub">8+ leads with conversion well below the program average of ' + fmtPct(avgConv, 0) + '</p></div></div>' +
          (coach.length ? coach.map(function (r) {
            return '<div class="coach-item"><span class="avatar">' + esc(initials(r.emp.name)) + '</span>' +
              '<span><b>' + esc(r.emp.name) + '</b><span class="cell-sub">' + esc(r.emp.dept) + ' · ' + fmtNum(r.s.total) + ' leads</span></span>' +
              '<span class="why">' + fmtPct(r.s.conversion, 0) + ' conversion<br>' + fmtNum(r.s.unqualified) + ' unqualified</span></div>';
          }).join('') : '<div class="empty">Nobody flagged — every active hunter is near or above the average.</div>') +
        '</section>' +
      '</div>' +

      '<section class="card">' +
        '<div class="card-head"><div><h3>Hunter performance</h3><p class="sub">Full ranking, revenue and commission per hunter — management only</p></div>' +
        '<a class="ghost-btn" href="#/performance" style="text-decoration:none">Open</a></div>' +
      '</section>';
  }

  /* ---- Finance: hunter profile drawer (full payout details) ---- */
  function fmtIbanFull(iban) {
    return iban ? iban.replace(/(.{4})/g, '$1 ').trim() : 'Not provided yet';
  }
  function openHunterDrawer(empId) {
    var emp = EMPLOYEES.find(function (e) { return e.id === empId; });
    if (!emp) return;
    var saved = LS.get('profile.' + emp.id, {});
    var pay = payoutDetailsOf(emp);
    var s = statsFor(leadsOf(emp.id));
    var old = document.getElementById('drawer-root');
    if (old) old.remove();

    var root = el('<div id="drawer-root">' +
      '<div class="drawer-backdrop"></div>' +
      '<div class="drawer" role="dialog" aria-label="Hunter profile">' +
        '<div class="d-head"><div style="display:flex; align-items:center; gap:11px">' +
          '<span class="avatar" style="width:42px;height:42px;flex:none;font-size:15px">' + esc(initials(emp.name)) + '</span>' +
          '<div><h2>' + esc(emp.name) + '</h2>' +
          '<p class="sub">' + esc(emp.title) + ' · ' + esc(emp.dept) + ' · Hunter ID ' + hunterCode(emp) + '</p></div></div>' +
        '<button class="icon-btn" id="drawer-close" aria-label="Close">✕</button></div>' +

        '<h3 class="eyebrow" style="margin-top:14px">Contact</h3>' +
        '<dl class="d-kv">' +
          '<dt>Company email</dt><dd>' + esc(saved.companyEmail || emp.email) + '</dd>' +
          '<dt>Mobile</dt><dd>' + esc(saved.phone || emp.phone || '—') + '</dd>' +
          (saved.personalEmail ? '<dt>Personal email</dt><dd>' + esc(saved.personalEmail) + '</dd>' : '') +
        '</dl>' +

        '<h3 class="eyebrow">Payout account</h3>' +
        '<dl class="d-kv">' +
          '<dt>Bank</dt><dd>' + esc(pay.bank) + '</dd>' +
          '<dt>IBAN</dt><dd style="font-variant-numeric:tabular-nums">' + esc(fmtIbanFull(pay.iban)) + '</dd>' +
          '<dt>Payout method</dt><dd>' + esc(saved.payMethod || 'Bank transfer (payroll)') + '</dd>' +
          (saved.nationalId ? '<dt>National ID / Iqama</dt><dd>' + esc(saved.nationalId) + '</dd>' : '') +
        '</dl>' +
        '<span class="hs-chip">🔒 Full IBAN visible to finance only — every view is access-logged in production</span>' +

        '<h3 class="eyebrow" style="margin-top:16px">Commission summary</h3>' +
        '<dl class="d-kv">' +
          '<dt>Deals won</dt><dd>' + fmtNum(s.won) + '</dd>' +
          '<dt>Still to pay</dt><dd><b class="money-pos">' + fmtMoney(s.commissionPending + s.commissionApproved) + '</b></dd>' +
          '<dt>Paid to date</dt><dd>' + fmtMoney(s.commissionPaid) + '</dd>' +
          '<dt>Lifetime commission</dt><dd>' + fmtMoney(s.commission) + '</dd>' +
        '</dl>' +
      '</div></div>');
    document.body.appendChild(root);
    function close() { root.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    root.querySelector('.drawer-backdrop').addEventListener('click', close);
    root.querySelector('#drawer-close').addEventListener('click', close);
    document.addEventListener('keydown', onKey);
  }

  /* ---- Finance: hunter directory ---- */
  function viewHunters(content) {
    var rows = EMPLOYEES.map(function (e) {
      var s = statsFor(leadsOf(e.id));
      var pay = payoutDetailsOf(e);
      return { e: e, s: s, pay: pay };
    }).sort(function (a, b) {
      return (b.s.commissionPending + b.s.commissionApproved) - (a.s.commissionPending + a.s.commissionApproved);
    });

    content.innerHTML =
      '<section class="card">' +
        '<div class="card-head"><div><h3>Hunter profiles</h3>' +
        '<p class="sub">Click a hunter to see full profile and payout account details</p></div></div>' +
        '<div class="tbl-wrap"><table>' +
          '<thead><tr><th>Hunter</th><th>Contact</th><th class="num">Deals won</th><th class="num">Still to pay</th><th class="num">Paid to date</th><th>Bank</th><th>IBAN</th></tr></thead>' +
          '<tbody>' + rows.map(function (r) {
            var owed = r.s.commissionPending + r.s.commissionApproved;
            return '<tr class="rowlink" data-hunter="' + r.e.id + '" tabindex="0">' +
              '<td><b>' + esc(r.e.name) + '</b><span class="cell-sub">' + esc(r.e.title) + ' · ' + esc(r.e.dept) + '</span></td>' +
              '<td>' + esc(r.e.email) + '<span class="cell-sub">' + esc(r.e.phone || '') + '</span></td>' +
              '<td class="num">' + fmtNum(r.s.won) + '</td>' +
              '<td class="num">' + (owed ? '<b class="money-pos">' + fmtMoney(owed) + '</b>' : '—') + '</td>' +
              '<td class="num">' + (r.s.commissionPaid ? fmtMoney(r.s.commissionPaid) : '—') + '</td>' +
              '<td>' + esc(r.pay.bank) + '</td>' +
              '<td>' + esc(maskIban(r.pay.iban)) + '</td>' +
            '</tr>';
          }).join('') + '</tbody>' +
        '</table></div>' +
      '</section>';

    content.querySelectorAll('[data-hunter]').forEach(function (tr) {
      function open() { openHunterDrawer(tr.getAttribute('data-hunter')); }
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter') open(); });
    });
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
      var rows = rowsFor().map(function (l) {
        var hunter = EMPLOYEES.find(function (e) { return e.id === l.hunterId; });
        var pay = hunter ? payoutDetailsOf(hunter) : { bank: '—', iban: '' };
        var cs = commissionStatus(l);
        return '<tr>' +
          '<td>' + (hunter
            ? '<a href="#" class="hunter-link" data-hunter="' + hunter.id + '"><b>' + esc(hunter.name) + '</b></a><span class="cell-sub">' + esc(hunter.dept) + '</span>'
            : '<b>Unknown</b>') + '</td>' +
          '<td><b>' + esc(l.company) + '</b><span class="cell-sub">deal ' + esc(l.id) + ' · <a href="#" class="hs-link" data-deal="' + esc(l.id) + '">open in HubSpot ↗</a></span></td>' +
          '<td>' + fmtDate(wonDate(l)) + '</td>' +
          '<td>' + esc(l.salesOwner) + '</td>' +
          '<td class="num">' + fmtMoney(l.amountNet) + '</td>' +
          '<td class="num"><b class="money-pos">' + fmtMoney(commissionOf(l)) + '</b></td>' +
          '<td><select class="status-select" data-deal="' + esc(l.id) + '" aria-label="Payment status for deal ' + esc(l.id) + '">' +
            [['pending', 'Pending approval'], ['approved', 'Approved'], ['paid', 'Paid']].map(function (o) {
              return '<option value="' + o[0] + '"' + (o[0] === cs ? ' selected' : '') + '>' + o[1] + '</option>';
            }).join('') + '</select></td>' +
          '<td>' + (cs === 'paid'
            ? (getSlips()[l.id]
                ? slipLink(l.id) + '<span class="cell-sub"><button class="linklike slip-up" data-deal="' + esc(l.id) + '">replace</button></span>'
                : '<button class="ghost-btn slip-up" data-deal="' + esc(l.id) + '">Upload payslip</button>')
            : '<span class="cell-sub">after payment</span>') + '</td>' +
          '<td>' + esc(pay.bank) + '<span class="cell-sub">' + esc(maskIban(pay.iban)) + '</span></td>' +
        '</tr>';
      }).join('');
      document.getElementById('payout-table').innerHTML =
        '<div class="tbl-wrap"><table>' +
          '<thead><tr><th>Hunter</th><th>Deal</th><th>Closed won</th><th>Closed by (sales rep)</th><th class="num">Value (excl. VAT)</th><th class="num">Commission (' + ratePct() + ')</th><th>Status</th><th>Payslip</th><th>Payout account</th></tr></thead>' +
          '<tbody>' + (rows || '<tr><td colspan="9"><div class="empty">No payouts match this filter.</div></td></tr>') + '</tbody>' +
        '</table></div>';
      document.querySelectorAll('.hs-link').forEach(function (a) {
        a.addEventListener('click', function (e) {
          e.preventDefault();
          toast('In production this opens deal ' + a.getAttribute('data-deal') + ' in HubSpot.');
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
          var overrides = LS.get('paystatus', {});
          overrides[dealId] = sel.value;
          LS.set('paystatus', overrides);
          COMMISSION_STATUS_OVERRIDES[dealId] = sel.value;
          audit('Set payment status of deal ' + dealId + ' to ' + sel.value);
          toast(sel.value === 'paid'
            ? 'Deal ' + dealId + ' marked “Paid” — attach the payslip so the hunter has proof.'
            : 'Deal ' + dealId + ' marked “' + sel.options[sel.selectedIndex].text + '” — the hunter sees this instantly.');
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
        tile('Still to pay', '<span class="money-pos">' + fmtMoneyC(owedTotal) + '</span>',
          fmtMoneyC(s.commissionPending) + ' pending review · ' + fmtMoneyC(s.commissionApproved) + ' approved') +
        tile('Paid to date', fmtMoneyC(s.commissionPaid), '') +
        tile('Hunters awaiting payout', fmtNum(huntersOwed), 'see Hunter Profiles for accounts') +
        tile('Total commission', fmtMoneyC(s.commission), ratePct() + ' of ' + fmtMoneyC(s.revenueNet) + ' net revenue');
    }

    content.innerHTML =
      '<div class="kpis" id="payout-tiles"></div>' +
      '<div class="filter-row">' +
        '<div class="seg" id="status-seg">' + [['all', 'All'], ['pending', 'Pending'], ['approved', 'Approved'], ['paid', 'Paid']].map(function (x, i) {
          return '<button data-seg="' + x[0] + '" class="' + (i === 0 ? 'active' : '') + '">' + x[1] + '</button>';
        }).join('') + '</div>' +
        '<div class="spacer"></div>' +
        '<button class="btn secondary" id="dl-payouts">Export payout run (CSV)</button>' +
      '</div>' +
      '<div class="card" id="payout-table"></div>' +
      '<input type="file" id="slip-file" hidden accept="application/pdf,image/png,image/jpeg">' +
      '<p class="sub" style="text-align:center">Payout accounts come from each hunter’s profile. IBANs are shown masked; in production the full IBAN is revealed to finance only at payout time, with access logged. Payslips are visible to the hunter and finance only.</p>';

    var pendingSlipDeal = null;
    document.getElementById('slip-file').addEventListener('change', function () {
      var f = this.files[0];
      this.value = '';
      if (!f || !pendingSlipDeal) return;
      if (f.size > 1.5 * 1024 * 1024) { toast('Keep payslips under 1.5 MB in the demo.'); return; }
      var deal = pendingSlipDeal;
      var reader = new FileReader();
      reader.onload = function () {
        if (saveSlip(deal, { name: f.name, dataUrl: reader.result, uploadedAt: new Date().toISOString() })) {
          audit('Uploaded payslip “' + f.name + '” for deal ' + deal);
          toast('Payslip attached to deal ' + deal + ' — the hunter can download it now.');
          renderTable();
        } else {
          toast('Could not store the file — browser storage is full.');
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
        var hunter = EMPLOYEES.find(function (e) { return e.id === l.hunterId; });
        var pay = hunter ? payoutDetailsOf(hunter) : { bank: '', iban: '' };
        lines.push([
          '"' + (hunter ? hunter.name : 'Unknown').replace(/"/g, '""') + '"',
          hunter ? hunter.dept : '', l.id,
          '"' + l.company.replace(/"/g, '""') + '"',
          fmtDate(wonDate(l)), '"' + l.salesOwner + '"',
          l.amountNet, commissionOf(l), commissionStatus(l),
          '"' + pay.bank + '"', maskIban(pay.iban)
        ].join(','));
      });
      var blob = new Blob([lines.join('\n')], { type: 'text/csv' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'sales-hunter-payout-run.csv';
      a.click();
      URL.revokeObjectURL(a.href);
      toast('Payout run exported.');
    });
    renderTiles();
    renderTable();
  }

  /* ---- Profile ---- */
  function viewProfile(content, user) {
    var saved = LS.get('profile.' + user.id, {});
    var p = Object.assign({
      name: user.name, dept: user.dept, title: user.title,
      companyEmail: user.email, personalEmail: '', phone: user.phone || '',
      bank: user.bank || BANKS[0], iban: user.iban || '', payMethod: 'Bank transfer (payroll)', nationalId: ''
    }, saved);

    function field(id, label, type, value, hint, attrs) {
      return '<div><label class="f-label" for="' + id + '">' + esc(label) + '</label>' +
        '<input type="' + type + '" id="' + id + '" value="' + esc(value) + '" ' + (attrs || '') + '>' +
        (hint ? '<p class="f-hint">' + esc(hint) + '</p>' : '') +
        '<p class="f-error" id="' + id + '-err" hidden></p></div>';
    }

    content.innerHTML =
      '<div class="card" style="max-width:760px">' +
        '<div style="display:flex; align-items:center; gap:14px; margin-bottom:18px">' +
          '<span class="avatar" style="width:46px;height:46px;flex:none;font-size:16px">' + esc(initials(user.name)) + '</span>' +
          '<div><h2>' + esc(user.name) + '</h2><p class="sub">' + esc(user.title) + ' · ' + esc(user.dept) + ' · manager: ' + esc(MANAGER.name) + '</p></div>' +
        '</div>' +
        '<form id="profile-form">' +
          '<h3 class="eyebrow" style="margin-bottom:10px">Contact information</h3>' +
          '<div class="form-grid">' +
            field('p-name', 'Full name', 'text', p.name) +
            field('p-phone', 'Mobile number', 'tel', p.phone) +
            field('p-cemail', 'Company email', 'email', p.companyEmail, 'Used for sign-in and lead notifications') +
            field('p-pemail', 'Personal email', 'email', p.personalEmail, 'Optional') +
          '</div>' +
          '<h3 class="eyebrow" style="margin:20px 0 10px">Payout details</h3>' +
          '<div class="form-grid">' +
            '<div><label class="f-label" for="p-bank">Bank</label><select id="p-bank">' +
              BANKS.map(function (b) { return '<option' + (b === p.bank ? ' selected' : '') + '>' + esc(b) + '</option>'; }).join('') + '</select></div>' +
            field('p-iban', 'IBAN', 'text', '',
              p.iban ? 'Current: ···· ' + p.iban.slice(-4) + ' — leave blank to keep it. Stored masked; never shown in full.'
                     : 'Saudi IBAN: SA followed by 22 digits',
              'placeholder="SA00 0000 0000 0000 0000 0000" autocomplete="off"') +
            '<div><label class="f-label" for="p-method">Preferred payout method</label><select id="p-method">' +
              ['Bank transfer (payroll)', 'Separate bank transfer'].map(function (m) { return '<option' + (m === p.payMethod ? ' selected' : '') + '>' + m + '</option>'; }).join('') + '</select></div>' +
            field('p-nid', 'National ID / Iqama (optional)', 'text', p.nationalId, 'Only needed if finance requires it for payout') +
          '</div>' +
          '<p class="f-hint" style="margin-top:14px">Payout details are stored encrypted and visible only to you and finance. In this demo they stay in your browser.</p>' +
          '<div style="margin-top:16px"><button type="submit" class="btn">Save profile</button></div>' +
        '</form>' +
      '</div>';

    document.getElementById('profile-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var iban = document.getElementById('p-iban').value.replace(/\s/g, '').toUpperCase();
      var ibanErr = document.getElementById('p-iban-err');
      if (iban && !/^SA\d{22}$/.test(iban)) {
        ibanErr.textContent = 'That does not look like a Saudi IBAN — it should be SA followed by 22 digits.';
        ibanErr.hidden = false;
        return;
      }
      ibanErr.hidden = true;
      if (!iban && p.iban) iban = p.iban; // blank keeps the saved one
      LS.set('profile.' + user.id, {
        name: document.getElementById('p-name').value,
        phone: document.getElementById('p-phone').value,
        companyEmail: document.getElementById('p-cemail').value,
        personalEmail: document.getElementById('p-pemail').value,
        bank: document.getElementById('p-bank').value,
        iban: iban,
        payMethod: document.getElementById('p-method').value,
        nationalId: document.getElementById('p-nid').value
      });
      toast('Profile saved.');
    });
  }

  /* ---------------- Boot ---------------- */
  Object.assign(COMMISSION_STATUS_OVERRIDES, LS.get('paystatus', {}));
  applyTheme();
  window.addEventListener('hashchange', route);
  route();
})();
