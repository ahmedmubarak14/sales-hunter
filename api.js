/* ============================================================
   Sales Hunter — live backend adapter (Supabase, zero-dependency)
   Talks to Supabase Auth + PostgREST + Storage with plain fetch.
   On sign-in it loads a snapshot (already filtered by row-level
   security) and reshapes rows into the exact structures the app
   renders, then flips window.LIVE on. Without a session — or
   with ?mode=mock — the app stays in demo mode untouched.
   ============================================================ */

window.LIVE = null;

window.SH_API = (function () {
  'use strict';

  var cfg = window.SH_CONFIG || null;
  var SESSION_KEY = 'sh.live.session';

  function enabled() {
    if (!cfg || !cfg.url || !cfg.key) return false;
    if (/[?&]mode=mock/.test(location.search)) return false;
    return true;
  }

  /* ---------------- session ---------------- */
  function getSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null; }
    catch (e) { return null; }
  }
  function setSession(s) {
    try {
      if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else localStorage.removeItem(SESSION_KEY);
    } catch (e) {}
  }

  /* Magic-link redirects land with tokens in the URL hash */
  function captureHashTokens() {
    var m = location.hash.match(/access_token=([^&]+)/);
    if (!m) return false;
    var params = {};
    location.hash.replace(/^#/, '').split('&').forEach(function (kv) {
      var p = kv.split('='); params[p[0]] = decodeURIComponent(p[1] || '');
    });
    if (params.access_token && params.refresh_token) {
      var payload = {};
      try { payload = JSON.parse(atob(params.access_token.split('.')[1])); } catch (e) {}
      var meta = payload.user_metadata || {};
      setSession({
        access_token: params.access_token,
        refresh_token: params.refresh_token,
        email: (payload.email || '').toLowerCase(),
        avatar: meta.avatar_url || meta.picture || null,
        expires_at: payload.exp ? payload.exp * 1000 : Date.now() + 3600 * 1000
      });
      history.replaceState(null, '', location.pathname + location.search);
      return true;
    }
    return false;
  }

  /* Failed magic links land with an error in the hash instead of tokens
     (e.g. #error=access_denied&error_code=otp_expired&...) */
  function captureHashError() {
    var m = location.hash.match(/error_code=([^&]+)/);
    if (!m && location.hash.indexOf('error=') < 0) return;
    window.LIVE_AUTH_ERROR = m ? decodeURIComponent(m[1]) : 'auth_error';
    history.replaceState(null, '', location.pathname + location.search);
  }

  /* ---------------- HTTP ---------------- */
  function headers(extra) {
    var h = Object.assign({ apikey: cfg.key, 'Content-Type': 'application/json' }, extra || {});
    var s = getSession();
    h.Authorization = 'Bearer ' + (s ? s.access_token : cfg.key);
    return h;
  }

  async function refreshSession() {
    var s = getSession();
    if (!s || !s.refresh_token) return false;
    var res = await fetch(cfg.url + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', headers: { apikey: cfg.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: s.refresh_token })
    });
    if (!res.ok) { setSession(null); return false; }
    var j = await res.json();
    setSession({
      access_token: j.access_token, refresh_token: j.refresh_token,
      email: (j.user && j.user.email || s.email || '').toLowerCase(),
      expires_at: Date.now() + (j.expires_in || 3600) * 1000
    });
    return true;
  }

  async function req(path, opts, retried) {
    opts = opts || {};
    var res = await fetch(cfg.url + path, {
      method: opts.method || 'GET',
      headers: headers(opts.headers),
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    });
    if (res.status === 401 && !retried && getSession()) {
      if (await refreshSession()) return req(path, opts, true);
    }
    if (!res.ok) {
      var txt = await res.text();
      throw new Error('HTTP ' + res.status + ' on ' + path + ': ' + txt.slice(0, 300));
    }
    if (res.status === 204) return null;
    var ct = res.headers.get('content-type') || '';
    return ct.includes('json') ? res.json() : res.text();
  }

  // PostgREST silently truncates any unpaginated "give me the whole
  // table" query at its configured max-rows (1000 here). A `select=*`
  // with no limit reads as "get everything" but is really "get up to
  // 1000, no warning if there's more" — the exact shape that made
  // sync-hubspot's amount-carry-forward set incomplete once deals passed
  // that count in one earlier incident. Pages via limit/offset behind a
  // caller-supplied, unique-column order (offset pagination is only
  // correct with a stable sort — ties on a non-unique column like
  // synced_at let rows shift between pages) until a page comes back
  // short of a full page, which is the actual proof nothing was left
  // behind — no separate "did we get everything" check needed.
  var PAGE_SIZE = 1000;
  async function reqAll(path, orderBy) {
    var sep = path.indexOf('?') >= 0 ? '&' : '?';
    var out = [], offset = 0;
    for (;;) {
      var page = await req(path + sep + 'order=' + orderBy + '&limit=' + PAGE_SIZE + '&offset=' + offset);
      out = out.concat(page);
      if (page.length < PAGE_SIZE) return out;
      offset += PAGE_SIZE;
    }
  }

  /* ---------------- auth ---------------- */
  async function sendMagicLink(email) {
    await req('/auth/v1/otp', {
      method: 'POST',
      body: { email: email, create_user: true, options: { email_redirect_to: location.origin + location.pathname } }
    });
  }
  /* Google SSO: Supabase runs the OAuth dance and redirects back with
     tokens in the hash, which captureHashTokens() picks up on load. */
  function signInWithGoogle() {
    location.href = cfg.url + '/auth/v1/authorize?provider=google&redirect_to=' +
      encodeURIComponent(location.origin + location.pathname);
  }
  async function verifyOtp(email, token) {
    var j = await req('/auth/v1/verify', {
      method: 'POST', body: { type: 'email', email: email, token: token }
    });
    setSession({
      access_token: j.access_token, refresh_token: j.refresh_token,
      email: email.toLowerCase(),
      expires_at: Date.now() + (j.expires_in || 3600) * 1000
    });
  }
  // Local session is cleared FIRST and synchronously, exactly as before —
  // every caller fires this and immediately calls location.reload() without
  // awaiting it, so anything gated behind a network round-trip risks being
  // aborted by the navigation before it runs. Revocation is then fired in
  // the background: without this, "sign out" only forgot the token on
  // THIS device — the refresh token stayed valid on Supabase's side until
  // natural expiry, so a token captured earlier (a stolen device, a
  // copied localStorage value) kept working after the user had signed
  // out. Best-effort only; there's nothing useful to do if it fails, and
  // the local sign-out must not depend on it succeeding.
  function signOut() {
    var s = getSession();
    setSession(null);
    window.LIVE = null;
    if (s && s.access_token) {
      fetch(cfg.url + '/auth/v1/logout', {
        method: 'POST',
        headers: { apikey: cfg.key, Authorization: 'Bearer ' + s.access_token }
      }).catch(function () {});
    }
  }

  /* ---------------- transforms ---------------- */
  function normStage(s) {
    s = String(s || '').toLowerCase().replace(/[^a-z]/g, '');
    // Match on "won"/"lost" alone, not "closedwon"/"closedlost" — real
    // pipeline stage names aren't consistent ("Closed Won" vs "Close
    // Lost", missing the "d"), and every stage seen so far only uses
    // one or the other word once.
    if (s.indexOf('won') >= 0) return 'won';
    if (s.indexOf('lost') >= 0) return 'lost';
    if (s.indexOf('unqual') >= 0) return 'unqualified';
    if (s.indexOf('reengage') >= 0) return 'reengage';
    if (s.indexOf('commit') >= 0) return 'commit';
    if (s === 'sql' || s.indexOf('salesqualified') >= 0) return 'sql';
    if (s.indexOf('qualif') >= 0 || s.indexOf('presales') >= 0) return 'qualified';
    if (s.indexOf('prospect') >= 0) return 'prospect';
    return 'new';
  }

  // Metabase's Purchasable Name is e.g. "Growth - Yearly" — the app only
  // ever showed a static demo plan list before subscriptions synced for
  // real, so this strips the billing-cycle suffix down to the plan tier.
  // Plans that Zid has since renamed, folded onto the current name so one
  // package doesn't show up as two rows split across its old and new
  // labels. Metabase keeps reporting whichever name the invoice was
  // written under, so this has to be handled here rather than upstream.
  var PLAN_ALIASES = { 'ZidLite': 'Rise' };

  // `subscriptions.started_at` is a Postgres `date` column, so PostgREST
  // sends it as a bare "2026-07-01" with no time or timezone. new
  // Date('2026-07-01') parses that as UTC midnight, which local getters
  // (monthKey's getMonth/getFullYear, used for the "won this month"
  // tiles and the 12-month charts) can read as the PREVIOUS calendar day
  // for anyone west of UTC — harmless in Saudi Arabia (UTC+3), wrong
  // wherever the viewer isn't. Parsed as local midnight instead.
  function parseDateOnly(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(s);
  }

  function basePlanName(purchasable) {
    if (!purchasable) return null;
    var base = String(purchasable).split(' - ')[0].trim();
    if (!base) return null;
    return PLAN_ALIASES[base] || base;
  }

  function toLead(d, eventsByDeal, subsByDeal) {
    var created = d.hs_created_at ? new Date(d.hs_created_at) : new Date(d.synced_at);
    var evs = (eventsByDeal[d.hubspot_deal_id] || []).map(function (e) {
      return { stage: normStage(e.to_stage), date: new Date(e.occurred_at) };
    }).sort(function (a, b) { return a.date - b.date; });
    if (!evs.length || evs[0].stage !== 'new') evs.unshift({ stage: 'new', date: created });
    var sub = (subsByDeal || {})[d.hubspot_deal_id];
    var stage = normStage(d.stage);
    // A real invoiced purchase outranks whatever stage the deal sits in.
    // Sales sometimes never drags a deal to Closed Won after the merchant
    // has already paid, which left that revenue, its commission and the
    // store itself uncounted while the deal still showed as open pipeline.
    // Metabase is the source of truth, so the invoice decides.
    var wonByInvoice = !!sub && stage !== 'won';
    if (wonByInvoice) stage = 'won';
    if (evs[evs.length - 1].stage !== stage) {
      // deal_stage_events has no real history yet, so this synthetic
      // "arrived at current stage" event needs a real date. Order matters:
      //
      // 1. Won by invoice → the purchase date IS the moment it was won.
      //    These deals are usually still open in HubSpot, so their
      //    closedate is a forecast, not a close.
      // 2. Genuinely closed (won/lost/unqualified) → HubSpot's close date.
      // 3. Anything else → synced_at, as a last resort.
      //
      // hs_closed_at used to win outright, but HubSpot populates
      // `closedate` on OPEN deals too as a forecast — often a future
      // date. That put invoice-won deals in the wrong (sometimes future)
      // month, dropping them out of the this-month tiles and the
      // 12-month charts entirely, and made open deals report a "last
      // activity" that hadn't happened yet.
      var TERMINAL_STAGE = { won: 1, lost: 1, unqualified: 1 };
      var stageDate = (wonByInvoice && sub && sub.started_at) ? parseDateOnly(sub.started_at)
        : (TERMINAL_STAGE[stage] && d.hs_closed_at) ? new Date(d.hs_closed_at)
        : new Date(d.synced_at);
      evs.push({ stage: stage, date: stageDate });
    }
    return {
      id: d.hubspot_deal_id,
      hunterId: (d.hunter_email || 'unassigned').toLowerCase(),
      company: d.company || d.hubspot_deal_id,
      contact: '',
      contactEmail: d.merchant_email || '',
      phone: d.merchant_phone || '',
      industry: d.industry || '',
      city: '', source: null,
      platform: d.platform || '', storeUrl: d.store_url || '', notes: d.notes || '',
      plan: sub ? basePlanName(sub.package) : null, years: 1,
      createdAt: created,
      stage: stage,
      events: evs,
      amountNet: d.amount_net !== null && d.amount_net !== undefined ? Number(d.amount_net) : 0,
      amountGross: d.amount_gross !== null && d.amount_gross !== undefined ? Number(d.amount_gross) : 0,
      // Paid for, but sales never moved it to Closed Won in HubSpot —
      // surfaced on the dashboard so someone goes and fixes the record.
      wonByInvoice: wonByInvoice, hubspotStage: d.stage,
      // Whether the deal was EVER marked lost/unqualified, not whether it
      // still is — deals get re-opened and moved to the nurturing
      // pipeline, and the reason cards count stage history like HubSpot.
      everLost: !!d.entered_lost_at,
      everUnqualified: !!d.entered_unqualified_at,
      lostReason: d.lost_reason, unqualReason: d.unqualified_reason,
      salesOwner: d.sales_owner || 'Unassigned'
    };
  }

  function fromDbRole(r) { return r === 'management' ? 'mgr' : r === 'finance' ? 'fin' : 'emp'; }
  function toDbRole(r) { return r === 'mgr' ? 'management' : r === 'fin' ? 'finance' : 'hunter'; }

  function toUser(u) {
    return {
      id: String(u.zid_email).toLowerCase(),
      dbId: u.id,
      name: u.name,
      dept: u.dept || 'General',
      title: u.title || '',
      email: String(u.zid_email).toLowerCase(),
      role: fromDbRole(u.role),
      // Every access this user holds, primary first. `role` stays the
      // landing view; the database grants on the whole set (has_access).
      accesses: [fromDbRole(u.role)].concat(
        (u.extra_roles || []).map(fromDbRole)
      ).filter(function (r, i, all) { return all.indexOf(r) === i; }),
      active: u.active !== false,
      avatar: u.avatar_url || null,
      avatarSource: u.avatar_source || 'google',
      aliases: (u.email_aliases || []).map(function (a) { return String(a).toLowerCase(); }),
      weight: 0
    };
  }

  /* ---------------- snapshot ---------------- */
  async function loadSnapshot() {
    var s = getSession();
    if (!s) return null;
    // Every full-table read below pages via reqAll rather than trusting a
    // single request to return everything — see reqAll's comment. The
    // order column is each table's primary key: unique, so pagination
    // can't skip or duplicate a row on a tie, and arbitrary otherwise —
    // nothing downstream depends on the order these arrive in, every
    // view re-sorts what it needs.
    var results = await Promise.all([
      reqAll('/rest/v1/app_users?select=*', 'id.asc'),
      reqAll('/rest/v1/deals?select=*', 'hubspot_deal_id.asc'),
      reqAll('/rest/v1/deal_stage_events?select=*', 'id.asc'),
      reqAll('/rest/v1/commissions?select=*', 'id.asc'),
      req('/rest/v1/settings?select=*'),
      reqAll('/rest/v1/profiles?select=*', 'user_id.asc'),
      reqAll('/rest/v1/payslips?select=*', 'id.asc').catch(function () { return []; }),
      reqAll('/rest/v1/store_showcase?select=*', 'store_id.asc').catch(function () { return []; }),
      req('/rest/v1/rpc/get_ibans', { method: 'POST', body: {} }).catch(function () { return []; }),
      reqAll('/rest/v1/subscriptions?select=hubspot_deal_id,package,billing_cycle,started_at', 'store_id.asc').catch(function () { return []; })
    ]);
    var users = results[0].map(toUser);
    var me = users.find(function (u) {
      return u.email === s.email || (u.aliases && u.aliases.indexOf(s.email) >= 0);
    });
    if (!me) {
      throw new Error('NO_APP_USER'); // signed in, but not in app_users → management must add them
    }
    // Sync the Google profile photo — but never override a photo the
    // user uploaded or deliberately removed (avatarSource !== 'google').
    if (s.avatar && me.avatarSource === 'google' && me.avatar !== s.avatar) {
      me.avatar = s.avatar;
      req('/rest/v1/rpc/set_avatar', { method: 'POST', body: { p_url: s.avatar } }).catch(function () {});
    }
    var eventsByDeal = {};
    results[2].forEach(function (e) {
      (eventsByDeal[e.hubspot_deal_id] = eventsByDeal[e.hubspot_deal_id] || []).push(e);
    });
    var subsByDeal = {};
    (results[9] || []).forEach(function (sub) {
      if (sub.hubspot_deal_id) subsByDeal[sub.hubspot_deal_id] = sub;
    });
    var leads = results[1].map(function (d) { return toLead(d, eventsByDeal, subsByDeal); });

    // A deal can carry more than one commissions row — sync-metabase
    // writes one per (deal, hunter, period), e.g. a store that invoices
    // in two separate months under the same deal. Keying commAmount by
    // deal id alone used to keep only whichever row loaded last, silently
    // under-reporting revenue whenever a deal had more than one. Every
    // row for a deal is grouped here so the amount is a real sum and the
    // status reflects all of them, not an arbitrary survivor.
    // Cleared, not just overwritten: a commission row that got deleted
    // or re-keyed (sync-metabase's merged-deal remap does exactly this)
    // used to leave its old status behind in this module-level map
    // forever — a deal could keep showing a stale "Paid" chip from a
    // previous session's data until a full page reload happened to
    // start with an empty object.
    COMMISSION_STATUS_OVERRIDES = {};
    var commAmount = {}, commByDeal = {}, commRowsByDeal = {}, payslipByComm = {};
    results[3].forEach(function (c) {
      (commRowsByDeal[c.hubspot_deal_id] = commRowsByDeal[c.hubspot_deal_id] || []).push(c);
      if (!commByDeal[c.hubspot_deal_id]) commByDeal[c.hubspot_deal_id] = c; // representative row (payslip lookups, etc.)
    });
    Object.keys(commRowsByDeal).forEach(function (dealId) {
      var rows = commRowsByDeal[dealId];
      commAmount[dealId] = rows.reduce(function (sum, c) { return sum + Number(c.commission_amount); }, 0);
      // Aggregate status: a deal isn't "paid" until every period behind
      // it is. Least-complete status wins, so a still-pending period
      // keeps the whole deal showing pending rather than flipping to
      // paid on the strength of one row that happened to sort last.
      var statuses = rows.map(function (c) { return c.workflow_status === 'awaiting_calc' ? 'pending' : c.workflow_status; });
      var overall = statuses.indexOf('pending') >= 0 ? 'pending'
        : statuses.indexOf('approved') >= 0 ? 'approved' : 'paid';
      COMMISSION_STATUS_OVERRIDES[dealId] = overall;
    });
    results[6].forEach(function (p) { payslipByComm[p.commission_id] = p; });

    var settings = {};
    results[4].forEach(function (row) { settings[row.key] = row.value; });

    var profilesByUser = {};
    results[5].forEach(function (p) { profilesByUser[p.user_id] = p; });

    var ibanByUser = {};
    (results[8] || []).forEach(function (r) { ibanByUser[r.user_id] = r.iban; });

    /* store_showcase rows (fed by the Metabase sync, ranked by all-time
       orders) → the category structure the Top Zid Stores page renders.
       Management/finance read the full table; for hunters RLS returns
       nothing, so fall back to the lite view without order volumes. */
    var showcaseRows = results[7];
    if (!showcaseRows.length) {
      // Paged like every other full-table read: the showcase carries the
      // top ten of every category Zid sells into, and a single request
      // stops at PostgREST's 1000-row cap — which would silently drop
      // whole categories off the end of the page.
      showcaseRows = await reqAll('/rest/v1/store_showcase_lite?select=*', 'store_id.asc')
        .catch(function () { return []; });
    }
    var byCat = {};
    showcaseRows.forEach(function (r) {
      (byCat[r.category] = byCat[r.category] || []).push({
        name: r.name,
        ordersCount: r.orders_count == null ? null : Number(r.orders_count),
        revenue: r.orders_total_sar == null ? null : Number(r.orders_total_sar),
        rank: r.rank_in_category || 999
      });
    });
    var showcase = Object.keys(byCat).map(function (c) {
      return { category: c, stores: byCat[c].sort(function (a, b) { return a.rank - b.rank; }) };
    });
    /* Categories arrive in whatever order the rows paged in, which is by
       store id — meaningless to a reader. Lead with the biggest category
       (by its number-one store's volume) where that figure is visible,
       and fall back to alphabetical for hunters, whose reduced view
       carries no order counts at all. */
    showcase.sort(function (a, b) {
      var av = a.stores[0] && a.stores[0].ordersCount, bv = b.stores[0] && b.stores[0].ordersCount;
      if (av != null && bv != null) return bv - av;
      return a.category.localeCompare(b.category);
    });

    return {
      me: me, users: users, leads: leads,
      commAmount: commAmount, commByDeal: commByDeal, commRowsByDeal: commRowsByDeal,
      payslipByComm: payslipByComm,
      profilesByUser: profilesByUser,
      ibanByUser: ibanByUser,
      settings: settings,
      showcase: showcase
    };
  }

  /* Swap the app's globals to live data (arrays mutated in place so
     every existing reference keeps working). */
  function activate(snap) {
    window.LIVE = snap;
    lastLoadedAt = Date.now();
    NOW = new Date();
    if (snap.settings.commission_rate_display) COMMISSION_RATE = Number(snap.settings.commission_rate_display);
    if (snap.settings.vat_rate_display) VAT_RATE = Number(snap.settings.vat_rate_display);
    EMPLOYEES.length = 0;
    snap.users.filter(function (u) { return u.role === 'emp'; }).forEach(function (u) { EMPLOYEES.push(u); });
    LEADS.length = 0;
    snap.leads.forEach(function (l) { LEADS.push(l); });
    LEADS.sort(function (a, b) { return b.createdAt - a.createdAt; });
  }

  /* Re-pull the snapshot for an already signed-in session. Used by the
     refresh control, tab-focus, and the periodic poll so the UI doesn't
     sit on data from sign-in time. */
  var lastLoadedAt = 0;
  function lastLoaded() { return lastLoadedAt; }
  async function refresh() {
    if (!enabled() || !getSession() || !window.LIVE) return false;
    var snap = await loadSnapshot();
    activate(snap);
    return true;
  }

  async function init() {
    if (!enabled()) return false;
    captureHashError();
    captureHashTokens();
    if (!getSession()) return false;
    try {
      var snap = await loadSnapshot();
      activate(snap);
      return true;
    } catch (e) {
      if (String(e.message).indexOf('NO_APP_USER') >= 0) {
        window.LIVE_ERROR = 'no_app_user';
      } else {
        window.LIVE_ERROR = String(e.message);
      }
      setSession(null);
      return false;
    }
  }

  /* ---------------- writes ---------------- */
  async function submitLead(f) {
    var id = 'APP-' + Math.random().toString(36).slice(2, 10).toUpperCase();
    var me = window.LIVE.me;
    await req('/rest/v1/deals', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: {
        hubspot_deal_id: id, company: f.company, hunter_email: me.email,
        stage: 'New Lead', industry: f.industry || null, platform: f.platform,
        store_url: f.storeUrl || null, merchant_email: f.contactEmail || null,
        merchant_phone: f.phone || null, notes: f.notes || null,
        hs_created_at: new Date().toISOString()
      }
    });
    var lead = toLead({
      hubspot_deal_id: id, company: f.company, hunter_email: me.email,
      stage: 'New Lead', industry: f.industry, platform: f.platform,
      store_url: f.storeUrl, merchant_email: f.contactEmail,
      merchant_phone: f.phone, notes: f.notes,
      hs_created_at: new Date().toISOString(), synced_at: new Date().toISOString()
    }, {});
    LEADS.unshift(lead);
    window.LIVE.leads.unshift(lead);
    return id;
  }

  /* Single write path for a user's own profile: identity fields on
     app_users, contact/bank on profiles, IBAN encrypted server-side,
     onboarded_at stamped on first save. */
  async function saveProfile(p) {
    var me = window.LIVE.me;
    await req('/rest/v1/rpc/save_profile', {
      method: 'POST',
      body: {
        p_name: p.name || null, p_dept: p.dept || null,
        p_phone: p.phone || null, p_personal_email: p.personalEmail || null,
        p_bank: p.bank || null, p_iban: p.iban || null,
        p_iban_cert_path: p.ibanCertPath || null
      }
    });
    if (p.name) me.name = p.name;
    if (p.dept) me.dept = p.dept;
    var u = window.LIVE.users.find(function (x) { return x.id === me.id; });
    if (u) { u.name = me.name; u.dept = me.dept; }
    var pr = window.LIVE.profilesByUser[me.dbId] || (window.LIVE.profilesByUser[me.dbId] = { user_id: me.dbId });
    if (p.phone) pr.phone = p.phone;
    if (p.personalEmail) pr.personal_email = p.personalEmail;
    if (p.bank) pr.bank = p.bank;
    if (p.iban) {
      pr.iban_last4 = p.iban.slice(-4);
      if (window.LIVE.ibanByUser) window.LIVE.ibanByUser[me.dbId] = p.iban;
    }
    if (p.ibanCertPath) pr.iban_cert_path = p.ibanCertPath;
    pr.onboarded_at = pr.onboarded_at || new Date().toISOString();
  }

  /* True while the signed-in user's profile is incomplete. The app
     blocks the hunter experience on this; management/finance access
     is never gated (the app checks the active role, not this alone). */
  function onboardingNeeded() {
    if (!window.LIVE) return false;
    var pr = window.LIVE.profilesByUser[window.LIVE.me.dbId];
    return !(pr && pr.onboarded_at);
  }

  async function setCommissionStatus(dealId, status) {
    // A deal can back more than one commissions row (one per invoice
    // period); the payouts page has a single status control per deal, so
    // that action has to apply to every row behind it — otherwise
    // marking one period paid left another silently pending in the
    // database while the UI, keyed off just the row that happened to
    // load last, showed the whole deal as paid.
    var rows = window.LIVE.commRowsByDeal[dealId] || (window.LIVE.commByDeal[dealId] ? [window.LIVE.commByDeal[dealId]] : []);
    if (!rows.length) throw new Error('No commission row for ' + dealId + ' yet (waiting for the Metabase calculation).');
    for (var i = 0; i < rows.length; i++) {
      await req('/rest/v1/rpc/set_commission_status', {
        method: 'POST', body: { p_id: rows[i].id, p_status: status }
      });
      rows[i].workflow_status = status;
    }
    COMMISSION_STATUS_OVERRIDES[dealId] = status;
  }

  async function uploadPayslip(dealId, file) {
    var c = window.LIVE.commByDeal[dealId];
    if (!c) throw new Error('No commission row for ' + dealId + ' yet.');
    var path = c.id + '/' + Date.now() + '-' + file.name.replace(/[^\w.\-]/g, '_');
    var s = getSession();
    var up = await fetch(cfg.url + '/storage/v1/object/payslips/' + path, {
      method: 'POST',
      headers: { apikey: cfg.key, Authorization: 'Bearer ' + s.access_token, 'Content-Type': file.type || 'application/octet-stream' },
      body: file
    });
    if (!up.ok) throw new Error('upload failed: HTTP ' + up.status);
    var row = await req('/rest/v1/payslips', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: { commission_id: c.id, storage_path: path, uploaded_by: window.LIVE.me.dbId }
    });
    window.LIVE.payslipByComm[c.id] = row[0];
  }

  /* ---------------- error reporting ---------------- */
  /* Fire-and-forget: never let logging break the thing that failed. */
  var lastLogged = '';
  function logError(message, context) {
    try {
      if (!enabled() || !getSession()) return;
      var msg = String(message || '').slice(0, 500);
      if (!msg || msg === lastLogged) return; // don't spam identical repeats
      lastLogged = msg;
      req('/rest/v1/client_errors', {
        method: 'POST', headers: { Prefer: 'return=minimal' },
        body: { message: msg, context: String(context || '').slice(0, 200), page: location.hash || '/' }
      }).catch(function () {});
    } catch (e) {}
  }
  async function recentErrors() {
    return req('/rest/v1/client_errors?select=*&order=created_at.desc&limit=25').catch(function () { return []; });
  }

  /* ---------------- profile photo ---------------- */
  function applyAvatarLocally(url, source) {
    var me = window.LIVE.me;
    me.avatar = url || null;
    me.avatarSource = source;
    var u = window.LIVE.users.find(function (x) { return x.id === me.id; });
    if (u) { u.avatar = me.avatar; u.avatarSource = source; }
  }
  /* Upload a photo to the public avatars bucket under the user's own id. */
  async function uploadAvatar(file) {
    var me = window.LIVE.me;
    var path = me.dbId + '/' + Date.now() + '-' + file.name.replace(/[^\w.\-]/g, '_');
    var s = getSession();
    var up = await fetch(cfg.url + '/storage/v1/object/avatars/' + path, {
      method: 'POST',
      headers: { apikey: cfg.key, Authorization: 'Bearer ' + s.access_token, 'Content-Type': file.type || 'application/octet-stream' },
      body: file
    });
    if (!up.ok) throw new Error('Photo upload failed: HTTP ' + up.status);
    var url = cfg.url + '/storage/v1/object/public/avatars/' + path;
    await req('/rest/v1/rpc/set_avatar_custom', { method: 'POST', body: { p_url: url } });
    applyAvatarLocally(url, 'custom');
    return url;
  }
  async function removeAvatar() {
    await req('/rest/v1/rpc/set_avatar_custom', { method: 'POST', body: { p_url: null } });
    applyAvatarLocally(null, 'none');
  }
  async function useGoogleAvatar() {
    var s = getSession();
    if (!s || !s.avatar) throw new Error('No Google photo on this sign-in.');
    await req('/rest/v1/rpc/reset_avatar_to_google', { method: 'POST', body: { p_url: s.avatar } });
    applyAvatarLocally(s.avatar, 'google');
  }
  function googleAvatarAvailable() {
    var s = getSession();
    return !!(s && s.avatar);
  }

  /* IBAN certificate: upload to the private iban-certs bucket under the
     user's own id, return the storage path to store on the profile. */
  async function uploadIbanCert(file) {
    var me = window.LIVE.me;
    var path = me.dbId + '/' + Date.now() + '-' + file.name.replace(/[^\w.\-]/g, '_');
    var s = getSession();
    var up = await fetch(cfg.url + '/storage/v1/object/iban-certs/' + path, {
      method: 'POST',
      headers: { apikey: cfg.key, Authorization: 'Bearer ' + s.access_token, 'Content-Type': file.type || 'application/octet-stream' },
      body: file
    });
    if (!up.ok) throw new Error('Certificate upload failed: HTTP ' + up.status);
    return path;
  }
  async function openIbanCert(path) {
    if (!path) return;
    var j = await req('/storage/v1/object/sign/iban-certs/' + path, {
      method: 'POST', body: { expiresIn: 300 }
    });
    window.open(cfg.url + '/storage/v1' + j.signedURL, '_blank', 'noopener');
  }

  async function openPayslip(dealId) {
    var c = window.LIVE.commByDeal[dealId];
    var p = c && window.LIVE.payslipByComm[c.id];
    if (!p) return;
    var j = await req('/storage/v1/object/sign/payslips/' + p.storage_path, {
      method: 'POST', body: { expiresIn: 300 }
    });
    window.open(cfg.url + '/storage/v1' + j.signedURL, '_blank', 'noopener');
  }

  function hasPayslip(dealId) {
    var c = window.LIVE.commByDeal[dealId];
    return !!(c && window.LIVE.payslipByComm[c.id]);
  }

  async function addUser(u) {
    var rows = await req('/rest/v1/app_users', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: { zid_email: u.email.toLowerCase(), name: u.name, dept: u.dept, title: u.title, role: toDbRole(u.role) }
    });
    var nu = toUser(rows[0]);
    window.LIVE.users.push(nu);
    if (nu.role === 'emp') EMPLOYEES.push(nu);
    return nu;
  }
  async function patchUser(email, patch) {
    var body = {};
    if (patch.role) body.role = toDbRole(patch.role);
    // accesses includes the primary; extra_roles is everything else.
    if (patch.accesses) {
      body.extra_roles = patch.accesses
        .filter(function (r) { return r !== (patch.role || 'emp'); })
        .map(toDbRole);
    }
    if (patch.active !== undefined) body.active = patch.active;
    if (patch.name) body.name = patch.name;
    if (patch.dept) body.dept = patch.dept;
    if (patch.title !== undefined) body.title = patch.title;
    await req('/rest/v1/app_users?zid_email=eq.' + encodeURIComponent(email), {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: body
    });
    var u = window.LIVE.users.find(function (x) { return x.email === email; });
    if (u) {
      ['role', 'active', 'name', 'dept', 'title'].forEach(function (k) {
        if (patch[k] !== undefined) u[k] = patch[k];
      });
      if (patch.accesses) u.accesses = patch.accesses.slice();
    }
  }

  /* Integrations: read status/settings (never the secret) and save. */
  async function getIntegrations() {
    return req('/rest/v1/integration_config?select=*').catch(function () { return []; });
  }
  async function saveIntegration(name, settings, secret) {
    await req('/rest/v1/rpc/save_integration', {
      method: 'POST', body: { p_name: name, p_settings: settings || {}, p_secret: secret || null }
    });
  }

  async function saveSettings(rate, vat) {
    await req('/rest/v1/settings?key=eq.commission_rate_display', {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: { value: rate }
    });
    await req('/rest/v1/settings?key=eq.vat_rate_display', {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: { value: vat }
    });
  }

  async function revealIban(userDbId) {
    return req('/rest/v1/rpc/reveal_iban', { method: 'POST', body: { p_user_id: userDbId } });
  }

  function profileOf(user) {
    return (window.LIVE && window.LIVE.profilesByUser[user.dbId]) || null;
  }

  return {
    enabled: enabled, init: init, getSession: getSession,
    sendMagicLink: sendMagicLink, verifyOtp: verifyOtp, signOut: signOut,
    signInWithGoogle: signInWithGoogle,
    submitLead: submitLead, saveProfile: saveProfile, onboardingNeeded: onboardingNeeded,
    setCommissionStatus: setCommissionStatus,
    uploadPayslip: uploadPayslip, openPayslip: openPayslip, hasPayslip: hasPayslip,
    uploadIbanCert: uploadIbanCert, openIbanCert: openIbanCert,
    uploadAvatar: uploadAvatar, removeAvatar: removeAvatar,
    useGoogleAvatar: useGoogleAvatar, googleAvatarAvailable: googleAvatarAvailable,
    refresh: refresh, lastLoaded: lastLoaded,
    logError: logError, recentErrors: recentErrors,
    addUser: addUser, patchUser: patchUser, saveSettings: saveSettings,
    getIntegrations: getIntegrations, saveIntegration: saveIntegration,
    revealIban: revealIban, profileOf: profileOf
  };
})();
