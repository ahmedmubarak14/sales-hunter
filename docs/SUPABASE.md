# Supabase setup — step by step

Everything below is copy-paste. Total time for steps 1–5: about 15 minutes.
Nothing here requires HubSpot or Metabase credentials — those plug in later.

## 1. Create the project (you)

1. supabase.com → New project.
   - Name: `sales-hunter`
   - Region: **Frankfurt (eu-central-1)** (closest stable region; latency is
     irrelevant for an internal dashboard)
   - Save the database password somewhere safe.
2. Note the two values under Settings → API:
   - Project URL (`https://<ref>.supabase.co`)
   - `anon` public key (the frontend will use this; the `service_role` key
     stays secret and is only ever used by Edge Functions).

## 2. Create the schema (you — 2 minutes)

SQL Editor → New query → paste the whole of
`supabase/migrations/001_init.sql` → Run.

That creates every table, the role-based row-level security, and the
security-definer functions (IBAN encryption/reveal, commission status
transitions, audit logging).

## 3. Set the IBAN encryption key (DONE — lives in Supabase Vault)

`ALTER DATABASE ... SET` is not permitted on managed Supabase, so the key
is stored in **Supabase Vault** as the secret named `iban_key`, and the
functions read it via the private `iban_key()` helper (migration 002).
Rotate it (Vault → edit secret) before any real IBAN is stored, since the
initial value passed through tooling during setup.

## 4. Create your first management user (DONE — ahmedmubaraks@hotmail.com as management)

```sql
insert into app_users (zid_email, name, dept, title, role)
values ('YOUR.EMAIL@zid.sa', 'Your Name', 'Marketing', 'Marketing Specialist', 'management');
```

## 5. Storage bucket for payslips (you — 1 minute)

Storage → New bucket → name `payslips`, **private**. (Access is via signed
URLs issued by the app; the RLS on the `payslips` table gates who can ask.)

## 6. Auth (Email OTP — two dashboard tweaks)

The app signs users in with a magic link **or** a 6-digit code (`api.js`).
Email provider is on by default; do these two things:

1. Authentication → Email Templates → **Magic Link**: add
   `{{ .Token }}` somewhere in the body so the email also contains the
   6-digit code (useful when the link's redirect URL doesn't match where
   the app is running).
2. Authentication → URL Configuration → set **Site URL** to where the app
   is hosted (Cloudflare Pages URL later; `http://localhost:8080` while
   testing locally with `python3 -m http.server 8080`).

Only people already in `app_users` can enter — a stranger who signs in
sees "management hasn't added you yet" and no data (RLS returns nothing).
The login email must equal `app_users.zid_email` — that IS the attribution
key; `email_aliases` covers old addresses. Google Workspace SSO can replace
OTP later without touching the schema.

## 7. Edge Functions (later, when building the sync — needs the CLI)

```bash
npx supabase login                       # uses a personal access token
npx supabase link --project-ref <ref>
npx supabase functions deploy sync-metabase sync-hubspot hubspot-webhook
```

Secrets (Dashboard → Edge Functions → Secrets), when credentials exist:

| Secret | From |
|---|---|
| `METABASE_URL`, `METABASE_KEY` | data team |
| `MB_CARD_COMMISSIONS`, `MB_CARD_SUBSCRIPTIONS`, `MB_CARD_TOPSTORES` | card IDs of the three saved questions |
| `HUBSPOT_TOKEN`, `HUBSPOT_APP_SECRET` | HubSpot admin (private app) |
| `HS_HUNTER_EMAIL_PROP` | internal name of the hunter-email deal property |

Schedules (Dashboard → Edge Functions → Schedules):
`sync-metabase` hourly, `sync-hubspot` hourly. The webhook URL goes into
HubSpot's webhook settings.

**Both sync functions run in MOCK mode when secrets are missing** — they
insert one fake row so the whole pipeline (function → table → RLS → app)
is testable before any credential exists.

## 8. Frontend hosting

Cloudflare Pages (or Supabase hosting) serving this repo's static files.
The frontend gets the Project URL + anon key and talks to Supabase
directly via supabase-js; RLS does the authorization. Swapping the app's
mock `data.js` for a Supabase-backed `api.js` is the Phase 1 frontend task.

## Safety notes

- The `service_role` key never ships to the browser and never leaves
  Edge Function secrets.
- `reveal_iban()` is finance-only and writes an audit row on every call —
  the promise the UI makes is enforced in the database.
- All sync writes use the service role; all user reads/writes go through
  RLS. Even a bug in the frontend cannot leak another hunter's rows.
