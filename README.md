# Sales Hunter — Zid employee referral portal (demo)

Sales Hunter is Zid's internal affiliate program: any employee can refer a
merchant, the sales team works the deal in HubSpot, and the employee earns
**20% of the subscription value (excl. 15% KSA VAT)** when it closes won.

Today the program runs on a form and manual follow-ups. This demo shows what
a self-service portal looks like: employees track their leads through the
real pipeline stages, see why leads were lost or unqualified, and watch their
commission build — while managers get program-wide reporting.

## Run it

No build step, no dependencies:

```
open index.html          # or just double-click it
# or serve it:
python3 -m http.server 8080
```

Sign in as any employee persona (or the Sales Director for the manager view).
All data is deterministic mock data generated in `data.js`.

## What's inside

| Page | For | Shows |
|---|---|---|
| Dashboard | employee | KPI tiles, hunter level, funnel, open-lead stages, outcome split, monthly trends, lost/unqualified reasons |
| My Leads | employee | Filterable table with stage, deal owner (sales rep), value, expected commission; click a row for the HubSpot-style timeline |
| Submit a Lead | employee | The referral form (replaces the manual form), Zid package selector |
| Commission | employee | Lifetime/pending/paid breakdown, the VAT → 20% math, per-deal history, CSV statement |
| Leaderboard | all | Ranking by revenue generated, badges/achievements |
| Top Zid Stores | all | Top-performing Zid store per category + category win rates, as pitch material |
| Program Overview | manager | Program KPIs, funnel, department & source comparison, coaching flags |
| My Profile | employee | Contact info + payout details (bank, masked IBAN with validation) |

## Pipeline stages

Mirrors the company HubSpot pipeline: **New Lead → Prospect → Qualified
(Pre-Sales) → SQL → Commit → Closed Won**, with **Closed Lost**,
**Unqualified**, and **Re-engage** as exits — so nothing has to be re-mapped
when the real integration lands.

## Architecture / path to production

- `data.js` — mock data shaped like HubSpot objects (deals, stages,
  closed-lost reasons). In production this file is replaced by the HubSpot
  CRM API (deals endpoint + webhooks); the UI does not change.
- `charts.js` — dependency-free SVG chart engine (funnel, columns, line,
  stacked bar) with tooltips and a table-view twin per chart.
- `app.js` — hash router + views. Demo state (persona, theme, submitted
  leads, profile) persists in `localStorage`.
- `styles.css` — Zid brand tokens (aubergine `#1F0433`, purple `#AE72FF`,
  validated chart palettes) with full light/dark theming.

Production hardening notes: SSO sign-in, payout details stored server-side
encrypted (or left to payroll), duplicate-lead checks against the CRM, and
commission rules for churn/refund clawbacks.
