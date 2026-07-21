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
  function signOut() { setSession(null); window.LIVE = null; }

  /* ---------------- transforms ---------------- */
  function normStage(s) {
    s = String(s || '').toLowerCase().replace(/[^a-z]/g, '');
    if (s.indexOf('closedwon') >= 0 || s === 'won') return 'won';
    if (s.indexOf('closedlost') >= 0 || s === 'lost') return 'lost';
    if (s.indexOf('unqual') >= 0) return 'unqualified';
    if (s.indexOf('reengage') >= 0) return 'reengage';
    if (s.indexOf('commit') >= 0) return 'commit';
    if (s === 'sql' || s.indexOf('salesqualified') >= 0) return 'sql';
    if (s.indexOf('qualif') >= 0 || s.indexOf('presales') >= 0) return 'qualified';
    if (s.indexOf('prospect') >= 0) return 'prospect';
    return 'new';
  }

  function toLead(d, eventsByDeal) {
    var created = d.hs_created_at ? new Date(d.hs_created_at) : new Date(d.synced_at);
    var evs = (eventsByDeal[d.hubspot_deal_id] || []).map(function (e) {
      return { stage: normStage(e.to_stage), date: new Date(e.occurred_at) };
    }).sort(function (a, b) { return a.date - b.date; });
    if (!evs.length || evs[0].stage !== 'new') evs.unshift({ stage: 'new', date: created });
    var stage = normStage(d.stage);
    if (evs[evs.length - 1].stage !== stage) evs.push({ stage: stage, date: new Date(d.synced_at) });
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
      plan: null, years: 1,
      createdAt: created,
      stage: stage,
      events: evs,
      amountNet: d.amount_net !== null && d.amount_net !== undefined ? Number(d.amount_net) : 0,
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
      secondaryRole: u.secondary_role ? fromDbRole(u.secondary_role) : null,
      active: u.active !== false,
      avatar: u.avatar_url || null,
      aliases: (u.email_aliases || []).map(function (a) { return String(a).toLowerCase(); }),
      weight: 0
    };
  }

  /* ---------------- snapshot ---------------- */
  async function loadSnapshot() {
    var s = getSession();
    if (!s) return null;
    var results = await Promise.all([
      req('/rest/v1/app_users?select=*'),
      req('/rest/v1/deals?select=*&order=synced_at.desc&limit=2000'),
      req('/rest/v1/deal_stage_events?select=*&limit=10000'),
      req('/rest/v1/commissions?select=*'),
      req('/rest/v1/settings?select=*'),
      req('/rest/v1/profiles?select=*'),
      req('/rest/v1/payslips?select=*').catch(function () { return []; }),
      req('/rest/v1/store_showcase?select=*').catch(function () { return []; }),
      req('/rest/v1/rpc/get_ibans', { method: 'POST', body: {} }).catch(function () { return []; })
    ]);
    var users = results[0].map(toUser);
    var me = users.find(function (u) {
      return u.email === s.email || (u.aliases && u.aliases.indexOf(s.email) >= 0);
    });
    if (!me) {
      throw new Error('NO_APP_USER'); // signed in, but not in app_users → management must add them
    }
    // Sync the Google profile photo to this user's row when it changes.
    if (s.avatar && me.avatar !== s.avatar) {
      me.avatar = s.avatar;
      req('/rest/v1/rpc/set_avatar', { method: 'POST', body: { p_url: s.avatar } }).catch(function () {});
    }
    var eventsByDeal = {};
    results[2].forEach(function (e) {
      (eventsByDeal[e.hubspot_deal_id] = eventsByDeal[e.hubspot_deal_id] || []).push(e);
    });
    var leads = results[1].map(function (d) { return toLead(d, eventsByDeal); });

    var commAmount = {}, commByDeal = {}, payslipByComm = {};
    results[3].forEach(function (c) {
      commAmount[c.hubspot_deal_id] = Number(c.commission_amount);
      commByDeal[c.hubspot_deal_id] = c;
      var st = c.workflow_status === 'awaiting_calc' ? 'pending' : c.workflow_status;
      COMMISSION_STATUS_OVERRIDES[c.hubspot_deal_id] = st;
    });
    results[6].forEach(function (p) { payslipByComm[p.commission_id] = p; });

    var settings = {};
    results[4].forEach(function (row) { settings[row.key] = row.value; });

    var profilesByUser = {};
    results[5].forEach(function (p) { profilesByUser[p.user_id] = p; });

    var ibanByUser = {};
    (results[8] || []).forEach(function (r) { ibanByUser[r.user_id] = r.iban; });

    /* store_showcase rows (fed by the Metabase sync) → the category
       structure the Top Zid Stores page renders. Management/finance
       read the full table; for hunters RLS returns nothing, so fall
       back to the lite view without order volumes. */
    var showcaseRows = results[7];
    if (!showcaseRows.length) {
      showcaseRows = await req('/rest/v1/store_showcase_lite?select=*').catch(function () { return []; });
    }
    var byCat = {};
    showcaseRows.forEach(function (r) {
      (byCat[r.category] = byCat[r.category] || []).push({
        name: r.name, city: r.city || '',
        ordersMo: r.orders_month == null ? null : Number(r.orders_month),
        growth: Number(r.growth) || 0, blurb: r.blurb || '',
        rank: r.rank_in_category || 999
      });
    });
    var showcase = Object.keys(byCat).map(function (c) {
      return { category: c, stores: byCat[c].sort(function (a, b) { return a.rank - b.rank; }) };
    });

    return {
      me: me, users: users, leads: leads,
      commAmount: commAmount, commByDeal: commByDeal,
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
    NOW = new Date();
    if (snap.settings.commission_rate_display) COMMISSION_RATE = Number(snap.settings.commission_rate_display);
    if (snap.settings.vat_rate_display) VAT_RATE = Number(snap.settings.vat_rate_display);
    EMPLOYEES.length = 0;
    snap.users.filter(function (u) { return u.role === 'emp'; }).forEach(function (u) { EMPLOYEES.push(u); });
    LEADS.length = 0;
    snap.leads.forEach(function (l) { LEADS.push(l); });
    LEADS.sort(function (a, b) { return b.createdAt - a.createdAt; });
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
    var c = window.LIVE.commByDeal[dealId];
    if (!c) throw new Error('No commission row for ' + dealId + ' yet (waiting for the Metabase calculation).');
    await req('/rest/v1/rpc/set_commission_status', {
      method: 'POST', body: { p_id: c.id, p_status: status }
    });
    c.workflow_status = status;
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
    if ('secondaryRole' in patch) body.secondary_role = patch.secondaryRole ? toDbRole(patch.secondaryRole) : null;
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
      if ('secondaryRole' in patch) u.secondaryRole = patch.secondaryRole || null;
    }
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
    addUser: addUser, patchUser: patchUser, saveSettings: saveSettings,
    revealIban: revealIban, profileOf: profileOf
  };
})();
