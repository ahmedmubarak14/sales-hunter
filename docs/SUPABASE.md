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

## 3. Set the IBAN encryption key (you — 1 minute)

SQL Editor:

```sql
alter database postgres set app.iban_key = '<long random string — keep it safe>';
```

Generate the string with a password manager (32+ chars). Losing it means
stored IBANs cannot be decrypted; treat it like a production secret.

## 4. Create your first management user (you — 1 minute)

```sql
insert into app_users (zid_email, name, dept, title, role)
values ('YOUR.EMAIL@zid.sa', 'Your Name', 'Marketing', 'Marketing Specialist', 'management');
```

## 5. Storage bucket for payslips (you — 1 minute)

Storage → New bucket → name `payslips`, **private**. (Access is via signed
URLs issued by the app; the RLS on the `payslips` table gates who can ask.)

## 6. Auth (can be deferred)

- Quickest start: Authentication → Providers → **Email (magic link / OTP)**
  restricted in the app to `@zid.sa` addresses.
- Proper setup: **Google** provider with the Zid Google Workspace (needs a
  Google OAuth client from IT — internal type, so no verification review).
- The login email must equal `app_users.zid_email` — that IS the
  attribution key. `email_aliases` covers old addresses.

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
