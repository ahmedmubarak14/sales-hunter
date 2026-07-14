# Sales Hunter — Integration Spec (HubSpot + Metabase + App DB)

This document is the request-for-access + build contract for making the
Sales Hunter portal functional. Hand the **HubSpot section** to the HubSpot
admin and the **Metabase section** to the data team; the rest is for
whoever builds the backend.

## 1. Architecture at a glance

```
HubSpot (CRM: deals, pipeline)          Metabase (warehouse views:
  │  webhooks + hourly poll              commissions, subscriptions,
  │  ▲ create contact/deal               top stores)
  ▼  │                                     │  scheduled API pulls (daily/hourly)
┌──────────────────────── Backend API + sync jobs ────────────────────────┐
│  Postgres: users · deals mirror · stage events · commissions mirror ·  │
│  payout workflow · payslips (object storage) · audit log · sync state  │
└──────────────────────────────┬──────────────────────────────────────────┘
                               ▼
                     Sales Hunter web app (existing)
```

Principles:
- **HubSpot owns the pipeline.** The app never edits deals; it mirrors them.
- **Metabase owns the money math.** Commission amounts are read from the
  existing commission calculation — never recomputed in the app.
- **The app DB owns identity and workflow**: users/roles, encrypted bank
  details, payout status (pending → approved → paid), payslips, audit.

## 2. Identity & join keys (confirmed)

- **Hunter identity = Zid email**, carried on the HubSpot deal and present
  in the Metabase commission output.
- **Deal identity = HubSpot deal ID**, also present in the Metabase
  commission output.

Consequences:
- SSO sign-in with the Zid email links a person to their deals and
  commissions automatically. No mapping table.
- Upsert keys: `deals.hubspot_deal_id` (unique);
  `commissions (hubspot_deal_id, hunter_email, period)` (unique).
- The sync must treat emails **case-insensitively** and trimmed.

Edge cases the backend must handle:
- **Unmatched commission rows**: a commission whose `hunter_email` matches
  no active user goes to an "unmatched" queue visible to Management
  (typo in HubSpot, employee left, alias). Never silently dropped.
- **Email changes**: match history by old email via a per-user
  `email_aliases` list editable by Management.
- One hunter per deal is assumed. If a deal's hunter email changes in
  HubSpot after a payout exists, flag it — do not reassign silently.

## 3. HubSpot requirements (for the HubSpot admin)

**Access**: a Private App token with scopes:
`crm.objects.deals.read`, `crm.objects.deals.write`,
`crm.objects.contacts.read`, `crm.objects.contacts.write`,
`crm.objects.companies.read`, `crm.objects.companies.write`,
`crm.schemas.deals.read`, webhooks.

**Properties on the Deal object** (please provide internal names):
- The property holding the **hunter's Zid email** (already in use by the
  commission calc — we need its exact internal name).
- Closed-lost reason property (standard `closed_lost_reason` or custom?).
- Unqualified reason property (which property/stage encodes it?).
- Amount / package: is the subscription package a property, a line item,
  or only in Zid's own systems?

**Pipeline mapping** (please provide stage IDs) for the pipeline with
stages: New Leads, Prospect, Unqualified, Re-engage,
Qualified | From Pre-Sales, SQL, Commit, Closed Won, Closed Lost.

**Webhooks**: subscription on `deal.propertyChange` for `dealstage` (and
`deal.creation`, `deal.deletion`) pointing at
`POST /webhooks/hubspot` (signature-verified with the app secret).

**Write path**: lead submission creates contact (+company) and a deal in
stage "New Leads" with the hunter-email property set, after a duplicate
search on email/phone/company name. Duplicate policy: if an open deal
already exists for the company, the submission is rejected with a
friendly message and the existing deal is NOT reassigned (first-touch
attribution stands).

**Reconciliation**: besides webhooks, an hourly `search` poll for deals
modified since the last sync bookmark (webhooks are best-effort).

## 4. Metabase requirements (for the data team)

**Access**: a Metabase API key (or service account) allowed to execute
three saved questions. The backend calls
`POST /api/card/{id}/query/json` on a schedule; results are upserted into
Postgres. The app never queries Metabase at request time.

**Q1 — Commissions** (hourly or daily). Required columns:
`hubspot_deal_id`, `hunter_email`, `store_id` (if available),
`base_amount` (net, excl. VAT), `commission_amount`, `currency`,
`calculated_at` / `period`, and if available a payment/collection flag.
This question is the **single source of truth for amounts**. The app adds
only workflow state on top (pending approval → approved → paid + payslip).

**Q2 — Subscriptions** (daily). Per store: `store_id`, package name,
billing cycle, start date, renewal/churn status, amounts. Used for the
package analytics and, later, renewal commissions / clawback rules.

**Q3 — Top stores by category** (daily). `store_id`, store name, category,
orders per month, growth. Feeds the Top Zid Stores pages. If merchant
names are sensitive, an approved allow-list or anonymized top-N works too.

Please send the column headers of the existing commission question — the
schema above adapts to what already exists rather than the reverse.

## 5. App database (Postgres) — core tables

- `users` (id, zid_email unique, name, dept, role: hunter|management|finance,
  active, email_aliases[])
- `profiles` (user_id, phone, bank, iban_encrypted, payout_method,
  national_id_encrypted) — encryption at the application layer (KMS key)
- `deals` — mirror keyed by `hubspot_deal_id`: stage, amounts, owner,
  hunter_email, company, reasons, created/closed timestamps
- `deal_stage_events` (deal_id, from_stage, to_stage, at) — from webhooks;
  powers funnels and timelines
- `commissions` — mirror of Metabase Q1, upsert-keyed as in §2, plus
  `workflow_status` (awaiting_calc | pending | approved | paid),
  `approved_by/at`, `paid_at`, `payout_run_id`
- `payout_runs` (id, created_by, period, exported_at) + CSV export
- `payslips` (commission_id, object_storage_key, uploaded_by/at)
- `audit_log` (who, action, entity, at) — status changes, payslip uploads,
  role changes, IBAN views
- `sync_state` (source, bookmark, last_run, last_error) + `sync_log`
- `settings` (program parameters; display-only — amounts come from Metabase)

## 6. Lifecycle (how the systems compose)

1. Hunter submits merchant → deal created in HubSpot (stage: New Leads).
2. Webhook/poll mirrors every stage change → hunter watches the timeline.
3. Deal hits **Closed Won** → app shows the win; commission shows as
   *expected* (from deal amount) until the calculation confirms it.
4. Metabase commission row appears → status becomes **pending approval**
   in the finance queue with the authoritative amount.
5. Finance approves → **approved**; payout run exported → **paid** +
   payslip uploaded; hunter sees each step live.

## 7. Security & compliance

- SSO (Zid's IdP) — the login email IS the attribution key; no passwords.
- IBAN/national ID encrypted at rest; full IBAN visible to finance only,
  each reveal audit-logged (the UI already behaves this way).
- Role-gated API endpoints matching the three app roles.
- PDPL review with IT before go-live; data retention policy for payslips.
- Hosting inside Zid infra or an IT-approved managed environment.

## 8. Hosting decision (made)

**Supabase** (managed Postgres + Auth + Storage + Edge Functions), frontend
on Cloudflare Pages. Rationale: the schema in §5 runs as plain Postgres,
SSO email = attribution key, RLS enforces the three roles in the database,
`pg_dump` migrates to Zid-internal infra later with zero schema changes.
Caveat: no KSA region — get IT sign-off for storing encrypted bank details
in the EU region, or keep IBANs masked until the app moves in-house.
Setup runbook: `docs/SUPABASE.md`; schema: `supabase/migrations/001_init.sql`;
sync jobs: `supabase/functions/`.

## 9. Build phases

- **Phase 0 — access (blocking):** HubSpot private app + property names +
  stage IDs; Metabase API key + Q1/Q2/Q3 definitions; SSO app registration.
- **Phase 1 (~1–2 wks):** backend + Postgres + Metabase sync → real
  commission numbers and the finance workflow go live.
- **Phase 2 (~2 wks):** HubSpot read sync + webhooks (hunter/manager views
  real) → then lead submission write path.
- **Phase 3 (~1 wk):** SSO, notifications (stage change / won / paid),
  hosting hardening, unmatched-commission queue UI.

## 10. Open items

- [ ] Internal name of the hunter-email deal property
- [ ] Closed-lost / unqualified reason property names
- [ ] Pipeline + stage IDs
- [ ] HubSpot private app token (sandbox first if available)
- [ ] Metabase API key + card IDs for Q1/Q2/Q3 (+ column headers)
- [ ] Where payment/collection status lives (Q1 column or separate?)
- [ ] SSO provider (Google Workspace / Microsoft) + app registration
- [ ] Hosting decision + object storage for payslips
- [ ] Commission policy sign-off: renewals? clawbacks? pay on collection?
