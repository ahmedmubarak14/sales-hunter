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
      setSession({
        access_token: params.access_token,
        refresh_token: params.refresh_token,
        email: (payload.email || '').toLowerCase(),
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

  function toUser(u) {
    return {
      id: String(u.zid_email).toLowerCase(),
      dbId: u.id,
      name: u.name,
      dept: u.dept || 'General',
      title: u.title || '',
      email: String(u.zid_email).toLowerCase(),
      role: u.role === 'management' ? 'mgr' : u.role === 'finance' ? 'fin' : 'emp',
      active: u.active !== false,
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
      req('/rest/v1/payslips?select=*').catch(function () { return []; })
    ]);
    var users = results[0].map(toUser);
    var me = users.find(function (u) {
      return u.email === s.email || (u.aliases && u.aliases.indexOf(s.email) >= 0);
    });
    if (!me) {
      throw new Error('NO_APP_USER'); // signed in, but not in app_users → management must add them
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

    return {
      me: me, users: users, leads: leads,
      commAmount: commAmount, commByDeal: commByDeal,
      payslipByComm: payslipByComm,
      profilesByUser: profilesByUser,
      settings: settings
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

  async function saveProfile(p) {
    var me = window.LIVE.me;
    await req('/rest/v1/profiles?on_conflict=user_id', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: {
        user_id: me.dbId, phone: p.phone || null, personal_email: p.personalEmail || null,
        bank: p.bank || null, payout_method: p.payMethod || null, updated_at: new Date().toISOString()
      }
    });
    if (p.iban) await req('/rest/v1/rpc/set_iban', { method: 'POST', body: { p_iban: p.iban } });
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
    var role = u.role === 'mgr' ? 'management' : u.role === 'fin' ? 'finance' : 'hunter';
    var rows = await req('/rest/v1/app_users', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: { zid_email: u.email.toLowerCase(), name: u.name, dept: u.dept, title: u.title, role: role }
    });
    var nu = toUser(rows[0]);
    window.LIVE.users.push(nu);
    if (nu.role === 'emp') EMPLOYEES.push(nu);
    return nu;
  }
  async function patchUser(email, patch) {
    var body = {};
    if (patch.role) body.role = patch.role === 'mgr' ? 'management' : patch.role === 'fin' ? 'finance' : 'hunter';
    if (patch.active !== undefined) body.active = patch.active;
    await req('/rest/v1/app_users?zid_email=eq.' + encodeURIComponent(email), {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: body
    });
    var u = window.LIVE.users.find(function (x) { return x.email === email; });
    if (u) {
      if (patch.role) u.role = patch.role;
      if (patch.active !== undefined) u.active = patch.active;
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
    submitLead: submitLead, saveProfile: saveProfile,
    setCommissionStatus: setCommissionStatus,
    uploadPayslip: uploadPayslip, openPayslip: openPayslip, hasPayslip: hasPayslip,
    addUser: addUser, patchUser: patchUser, saveSettings: saveSettings,
    revealIban: revealIban, profileOf: profileOf
  };
})();
