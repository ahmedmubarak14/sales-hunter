/* ============================================================
   Sales Hunter — mock data layer
   Shaped like HubSpot objects (deals, stages, closed-lost
   reasons) so production can swap this file for the HubSpot
   CRM API without touching the UI.
   Data is deterministic: same numbers on every load.
   ============================================================ */

// Fixed "today" so the demo is stable and screenshots match.
var NOW = new Date('2026-07-10T12:00:00');
var DAY = 24 * 60 * 60 * 1000;

var VAT_RATE = 0.15;        // KSA standard VAT
var COMMISSION_RATE = 0.20; // 20% of subscription value excl. VAT

/* ---- Pipeline stages (mirrors the company HubSpot pipeline) ---- */
var STAGES = [
  { id: 'new',         label: 'New Lead',                group: 'open'  },
  { id: 'prospect',    label: 'Prospect',                group: 'open'  },
  { id: 'qualified',   label: 'Qualified (Pre-Sales)',   group: 'open'  },
  { id: 'sql',         label: 'SQL',                     group: 'open'  },
  { id: 'commit',      label: 'Commit',                  group: 'open'  },
  { id: 'won',         label: 'Closed Won',              group: 'won'   },
  { id: 'lost',        label: 'Closed Lost',             group: 'lost'  },
  { id: 'unqualified', label: 'Unqualified',             group: 'unq'   },
  { id: 'reengage',    label: 'Re-engage',               group: 'open'  }
];
var STAGE_BY_ID = {};
STAGES.forEach(function (s) { STAGE_BY_ID[s.id] = s; });

// Ordered progression for the funnel (reach order)
var FUNNEL_ORDER = ['new', 'prospect', 'qualified', 'sql', 'commit', 'won'];

var LOST_REASONS = [
  'Price too high',
  'Chose a competitor',
  'No budget this year',
  'Project postponed',
  'Went silent / no response',
  'Signed shorter pilot elsewhere'
];
var UNQUALIFIED_REASONS = [
  'Not an ICP fit',
  'Company too small',
  'Already an existing customer',
  'Duplicate lead',
  'No real need identified',
  'Wrong contact person'
];
var SOURCES = ['Personal network', 'Instagram / TikTok seller', 'Event / bazaar', 'Merchant referral', 'Family & friends', 'Referral link'];
/* Zid store categories — leads are merchants who could open a Zid store */
var INDUSTRIES = ['Fashion & Apparel', 'Food & Beverage', 'Beauty & Care', 'Electronics', 'Home & Furniture', 'Health & Sports', 'Gifts & Flowers', 'Grocery', 'Books & Stationery', 'Pets'];
var CITIES = ['Riyadh', 'Jeddah', 'Dammam', 'Makkah', 'Madinah', 'Khobar', 'Tabuk', 'Abha'];

/* Zid subscription packages (SAR / year, excl. VAT) */
var PLANS = [
  { name: 'Launch', price: 990 },
  { name: 'Growth', price: 2990 },
  { name: 'Professional', price: 20000 }
];

/* Top-performing Zid store per category (mock showcase for pitching) */
var TOP_STORES = [
  { category: 'Fashion & Apparel',  store: 'Lamsa Boutique',      city: 'Riyadh',  ordersMo: 4236, growth: 0.38, blurb: 'Instagram seller that moved to Zid and tripled repeat purchases with its own app.' },
  { category: 'Food & Beverage',    store: 'Bin Saif Roastery',   city: 'Jeddah',  ordersMo: 3105, growth: 0.52, blurb: 'Subscription coffee boxes now drive half of monthly revenue.' },
  { category: 'Beauty & Care',      store: 'Nara Beauty',         city: 'Riyadh',  ordersMo: 2870, growth: 0.44, blurb: 'Launched on Zid in Ramadan season and hit 10K orders in six months.' },
  { category: 'Electronics',        store: 'Volt Store',          city: 'Khobar',  ordersMo: 1922, growth: 0.27, blurb: 'Uses Zid shipping integrations to deliver same-day in the Eastern Province.' },
  { category: 'Home & Furniture',   store: 'Dar Alwan',           city: 'Dammam',  ordersMo: 1490, growth: 0.31, blurb: 'Bulky-item logistics handled end-to-end through Zid partners.' },
  { category: 'Health & Sports',    store: 'Enduro KSA',          city: 'Riyadh',  ordersMo: 1218, growth: 0.35, blurb: 'Grew from a gym counter to nationwide supplements delivery.' },
  { category: 'Gifts & Flowers',    store: 'Ward & Co.',          city: 'Jeddah',  ordersMo: 987,  growth: 0.41, blurb: 'Same-day gifting with scheduled delivery slots at checkout.' },
  { category: 'Grocery',            store: 'Baqalah Plus',        city: 'Madinah', ordersMo: 2540, growth: 0.22, blurb: 'Neighborhood mini-market turned quick-commerce operation.' },
  { category: 'Books & Stationery', store: 'Warraq',              city: 'Riyadh',  ordersMo: 640,  growth: 0.18, blurb: 'Niche Arabic titles with nationwide reach and pre-orders.' },
  { category: 'Pets',               store: 'Mishmish Pets',       city: 'Jeddah',  ordersMo: 512,  growth: 0.29, blurb: 'Recurring pet-food subscriptions keep customers for years.' }
];
var SALES_OWNERS = ['Fahad Al-Otaibi', 'Sara Al-Zahrani', 'Mohammed Iqbal', 'Lama Al-Harbi'];
var BANKS = ['Al Rajhi Bank', 'Saudi National Bank', 'Riyad Bank', 'Alinma Bank', 'SAB', 'Bank Albilad', 'Arab National Bank'];

/* ---- Program participants (the hunters) ---- */
var EMPLOYEES = [
  { id: 'e1',  name: 'Ahmed Mubarak',    dept: 'Marketing',        title: 'Marketing Specialist',   email: 'ahmed.mubarak@company.com',  phone: '+966 55 010 1122', weight: 30 },
  { id: 'e2',  name: 'Noura Al-Qahtani', dept: 'Customer Success', title: 'CS Manager',             email: 'noura.q@company.com',        phone: '+966 55 233 8801', weight: 26 },
  { id: 'e3',  name: 'Omar Basha',       dept: 'Finance',          title: 'Financial Analyst',      email: 'omar.basha@company.com',     phone: '+966 54 771 0392', weight: 18 },
  { id: 'e4',  name: 'Reem Al-Dossari',  dept: 'HR',               title: 'HR Business Partner',    email: 'reem.d@company.com',         phone: '+966 56 402 5518', weight: 22 },
  { id: 'e5',  name: 'Yousef Hamdan',    dept: 'Operations',       title: 'Ops Coordinator',        email: 'yousef.h@company.com',       phone: '+966 50 918 2244', weight: 14 },
  { id: 'e6',  name: 'Dana Al-Shehri',   dept: 'Marketing',        title: 'Content Lead',           email: 'dana.s@company.com',         phone: '+966 55 640 7731', weight: 20 },
  { id: 'e7',  name: 'Khalid Nasser',    dept: 'IT',               title: 'Systems Engineer',       email: 'khalid.n@company.com',       phone: '+966 53 305 6647', weight: 10 },
  { id: 'e8',  name: 'Huda Al-Amoudi',   dept: 'Customer Success', title: 'Onboarding Specialist',  email: 'huda.a@company.com',         phone: '+966 55 884 9913', weight: 16 },
  { id: 'e9',  name: 'Tariq Mansour',    dept: 'Operations',       title: 'Logistics Planner',      email: 'tariq.m@company.com',        phone: '+966 54 112 3378', weight: 8  },
  { id: 'e10', name: 'Lina Farouk',      dept: 'HR',               title: 'Recruiter',              email: 'lina.f@company.com',         phone: '+966 56 990 4415', weight: 12 }
];

var MANAGER = { id: 'mgr', name: 'Abdullah Al-Rashid', dept: 'Sales', title: 'Sales Director', email: 'abdullah.r@company.com' };
var FINANCE = { id: 'fin', name: 'Maha Al-Otaibi', dept: 'Finance', title: 'Finance Operations', email: 'maha.o@company.com' };

/* Default payout details per employee (profile edits override these) */
EMPLOYEES.forEach(function (e, i) {
  e.bank = BANKS[i % BANKS.length];
  e.iban = 'SA' + '0380000060801016' + String(801674 - i * 37); // SA + 22 digits, deterministic
});

/* ---- Deterministic PRNG (mulberry32) ---- */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
var rand = mulberry32(20260710);
function ri(min, max) { return Math.floor(rand() * (max - min + 1)) + min; }
function pick(arr) { return arr[Math.floor(rand() * arr.length)]; }
function pickWeighted(pairs) { // [[value, weight], ...]
  var total = 0, i;
  for (i = 0; i < pairs.length; i++) total += pairs[i][1];
  var r = rand() * total;
  for (i = 0; i < pairs.length; i++) { r -= pairs[i][1]; if (r <= 0) return pairs[i][0]; }
  return pairs[pairs.length - 1][0];
}

/* ---- Company & contact name generation ---- */
var CO_FIRST = ['Lulwa', 'Najd', 'Red Sea', 'Sadeem', 'Ghima', 'Oasis', 'Falcon', 'Arabian', 'Golden Sands', 'Al Noor',
  'Salam', 'Horizon', 'Wadi', 'Crescent', 'Palm', 'Yara', 'Safa', 'Summit', 'Pearl', 'Reef'];
var CO_SECOND = ['Boutique', 'Store', 'Collection', 'Sweets', 'Coffee Roasters', 'Perfumes', 'Electronics', 'Furniture',
  'Gifts', 'Fashion', 'Beauty', 'Home', 'Abayas', 'Dates', 'Concept'];
var P_FIRST = ['Saleh', 'Mona', 'Faisal', 'Aisha', 'Hassan', 'Layla', 'Majed', 'Nada', 'Sami', 'Rania', 'Waleed', 'Hind', 'Ibrahim', 'Amal', 'Ziyad'];
var P_LAST = ['Al-Ghamdi', 'Al-Mutairi', 'Khan', 'Al-Subaie', 'Haddad', 'Al-Juhani', 'Nasr', 'Al-Anazi', 'Fares', 'Al-Malki', 'Aziz', 'Al-Rashidi'];

var usedCompanies = {};
function companyName() {
  for (var tries = 0; tries < 40; tries++) {
    var name = pick(CO_FIRST) + ' ' + pick(CO_SECOND);
    if (!usedCompanies[name]) { usedCompanies[name] = true; return name; }
  }
  var n = 'Branch ' + ri(2, 9);
  return pick(CO_FIRST) + ' ' + pick(CO_SECOND) + ' — ' + n;
}
function personName() { return pick(P_FIRST) + ' ' + pick(P_LAST); }

/* ---- Lead lifecycle simulation ----
   Each lead walks the pipeline with dwell times; events after
   "today" are dropped, which naturally leaves recent leads open
   mid-pipeline. */
/* Store-name suffix → plausible category */
var SUFFIX_CAT = {
  'Sweets': 'Food & Beverage', 'Dates': 'Food & Beverage', 'Coffee Roasters': 'Food & Beverage',
  'Boutique': 'Fashion & Apparel', 'Fashion': 'Fashion & Apparel', 'Abayas': 'Fashion & Apparel',
  'Perfumes': 'Beauty & Care', 'Beauty': 'Beauty & Care',
  'Electronics': 'Electronics', 'Furniture': 'Home & Furniture', 'Home': 'Home & Furniture',
  'Gifts': 'Gifts & Flowers'
};
function categoryFor(company) {
  var keys = Object.keys(SUFFIX_CAT);
  for (var i = 0; i < keys.length; i++) {
    if (company.indexOf(keys[i]) !== -1) return SUFFIX_CAT[keys[i]];
  }
  return pick(INDUSTRIES);
}

var leadSeq = 0;
function makeLead(hunterId) {
  leadSeq += 1;
  // Skewed toward recent months: the program is growing
  var ageDays = Math.floor(2 + 363 * Math.pow(rand(), 1.35));
  var createdAt = new Date(NOW.getTime() - ageDays * DAY - ri(0, 23) * 3600 * 1000);
  var events = [{ stage: 'new', date: createdAt }];
  var t = createdAt.getTime();
  var final = null, lostReason = null, unqualReason = null;

  function push(stage, minD, maxD) {
    t += ri(minD, maxD) * DAY + ri(0, 20) * 3600 * 1000;
    events.push({ stage: stage, date: new Date(t) });
  }

  // new →
  if (rand() < 0.10) { push('unqualified', 1, 5); final = 'unqualified'; }
  else {
    push('prospect', 2, 10);
    if (rand() < 0.12) { push('unqualified', 2, 8); final = 'unqualified'; }
    else if (rand() < 0.08) { push('reengage', 5, 20); final = 'reengage'; }
    else {
      push('qualified', 4, 15);
      if (rand() < 0.10) { push('lost', 3, 12); final = 'lost'; }
      else if (rand() < 0.05) { push('reengage', 5, 20); final = 'reengage'; }
      else {
        push('sql', 5, 20);
        if (rand() < 0.25) { push('lost', 4, 15); final = 'lost'; }
        else {
          push('commit', 7, 25);
          if (rand() < 0.30) { push('lost', 4, 15); final = 'lost'; }
          else { push('won', 5, 15); final = 'won'; }
        }
      }
    }
  }

  // Drop future events → lead is still open at its last reached stage
  events = events.filter(function (e) { return e.date.getTime() <= NOW.getTime(); });
  var currentStage = events[events.length - 1].stage;
  if (currentStage !== final) { lostReason = null; unqualReason = null; }
  if (currentStage === 'lost') lostReason = pickWeighted([
    [LOST_REASONS[0], 28], [LOST_REASONS[1], 24], [LOST_REASONS[2], 18],
    [LOST_REASONS[3], 14], [LOST_REASONS[4], 11], [LOST_REASONS[5], 5]
  ]);
  if (currentStage === 'unqualified') unqualReason = pickWeighted([
    [UNQUALIFIED_REASONS[0], 30], [UNQUALIFIED_REASONS[1], 22], [UNQUALIFIED_REASONS[2], 16],
    [UNQUALIFIED_REASONS[3], 12], [UNQUALIFIED_REASONS[4], 12], [UNQUALIFIED_REASONS[5], 8]
  ]);

  // Zid package: subscription value excl. VAT (HubSpot deal amount).
  // Some merchants sign for two years up front.
  var plan = pickWeighted([[PLANS[0], 32], [PLANS[1], 48], [PLANS[2], 20]]);
  var years = rand() < 0.15 ? 2 : 1;
  var amountNet = plan.price * years;

  var company = companyName();
  return {
    id: 'L-' + String(1000 + leadSeq),
    hunterId: hunterId,
    company: company,
    contact: personName(),
    plan: plan.name,
    years: years,
    industry: categoryFor(company),
    city: pick(CITIES),
    source: pick(SOURCES),
    createdAt: createdAt,
    stage: currentStage,
    events: events,
    amountNet: amountNet,
    lostReason: lostReason,
    unqualReason: unqualReason,
    salesOwner: pick(SALES_OWNERS)
  };
}

var LEADS = [];
EMPLOYEES.forEach(function (emp) {
  var n = Math.max(4, Math.round(emp.weight * (0.85 + rand() * 0.3)));
  for (var i = 0; i < n; i++) LEADS.push(makeLead(emp.id));
});
LEADS.sort(function (a, b) { return b.createdAt - a.createdAt; });

/* ---- Derived helpers (single source of truth for all views) ---- */

function wonDate(lead) {
  for (var i = 0; i < lead.events.length; i++) if (lead.events[i].stage === 'won') return lead.events[i].date;
  return null;
}
function closedDate(lead) { // date the lead reached a terminal stage
  var last = lead.events[lead.events.length - 1];
  return (lead.stage === 'won' || lead.stage === 'lost' || lead.stage === 'unqualified') ? last.date : null;
}
function lastActivity(lead) { return lead.events[lead.events.length - 1].date; }

function commissionOf(lead) { // 20% of subscription value excl. VAT
  return lead.stage === 'won' ? Math.round(lead.amountNet * COMMISSION_RATE) : 0;
}
function grossOf(lead) { return Math.round(lead.amountNet * (1 + VAT_RATE)); }

// Commission payout status is driven by how long ago the deal closed.
function commissionStatus(lead) {
  if (lead.stage !== 'won') return null;
  var age = (NOW - wonDate(lead)) / DAY;
  if (age > 60) return 'paid';
  if (age > 25) return 'approved';
  return 'pending';
}

// Leads the hunter still has in play (anything not terminal)
function isOpen(lead) { return STAGE_BY_ID[lead.stage].group === 'open'; }

// Did this lead ever reach the given funnel stage?
function reached(lead, stageId) {
  for (var i = 0; i < lead.events.length; i++) if (lead.events[i].stage === stageId) return true;
  return false;
}

function statsFor(leads) {
  var s = {
    total: leads.length, won: 0, lost: 0, unqualified: 0, open: 0,
    revenueNet: 0, commission: 0, commissionPaid: 0, commissionApproved: 0, commissionPending: 0,
    pipelineValue: 0, byStage: {}, funnel: [], lostReasons: {}, unqualReasons: {},
    avgCycleDays: null
  };
  STAGES.forEach(function (st) { s.byStage[st.id] = 0; });
  var cycleSum = 0, cycleN = 0;
  leads.forEach(function (l) {
    s.byStage[l.stage] += 1;
    if (l.stage === 'won') {
      s.won += 1; s.revenueNet += l.amountNet;
      var c = commissionOf(l), cs = commissionStatus(l);
      s.commission += c;
      if (cs === 'paid') s.commissionPaid += c;
      else if (cs === 'approved') s.commissionApproved += c;
      else s.commissionPending += c;
      cycleSum += (wonDate(l) - l.createdAt) / DAY; cycleN += 1;
    } else if (l.stage === 'lost') {
      s.lost += 1;
      if (l.lostReason) s.lostReasons[l.lostReason] = (s.lostReasons[l.lostReason] || 0) + 1;
    } else if (l.stage === 'unqualified') {
      s.unqualified += 1;
      if (l.unqualReason) s.unqualReasons[l.unqualReason] = (s.unqualReasons[l.unqualReason] || 0) + 1;
    } else {
      s.open += 1; s.pipelineValue += l.amountNet;
    }
  });
  s.conversion = s.total ? s.won / s.total : 0;
  s.avgCycleDays = cycleN ? Math.round(cycleSum / cycleN) : null;
  s.funnel = FUNNEL_ORDER.map(function (stageId) {
    return {
      stage: STAGE_BY_ID[stageId].label,
      count: leads.filter(function (l) { return reached(l, stageId); }).length
    };
  });
  return s;
}

/* Demo storytelling: the featured persona (e1) should have fresh wins so
   the pending/approved commission states and "this month" tiles are alive. */
function shiftLeadEnd(lead, targetEnd) {
  var last = lead.events[lead.events.length - 1].date.getTime();
  var delta = targetEnd.getTime() - last;
  lead.events.forEach(function (e) { e.date = new Date(e.date.getTime() + delta); });
  lead.createdAt = lead.events[0].date;
}
(function () {
  var e1Wins = LEADS.filter(function (l) { return l.hunterId === 'e1' && l.stage === 'won'; })
    .sort(function (a, b) { return b.events[b.events.length - 1].date - a.events[a.events.length - 1].date; });
  if (e1Wins[0]) shiftLeadEnd(e1Wins[0], new Date(NOW.getTime() - 6 * DAY));   // pending approval, this month
  if (e1Wins[1]) shiftLeadEnd(e1Wins[1], new Date(NOW.getTime() - 33 * DAY));  // approved, last month
  LEADS.sort(function (a, b) { return b.createdAt - a.createdAt; });           // restore newest-first order
})();

/* Month helpers for trend charts (last 12 months incl. current) */
function monthKey(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
function last12Months() {
  var out = [];
  for (var i = 11; i >= 0; i--) {
    var d = new Date(NOW.getFullYear(), NOW.getMonth() - i, 1);
    out.push({ key: monthKey(d), label: d.toLocaleString('en', { month: 'short' }), date: d });
  }
  return out;
}
