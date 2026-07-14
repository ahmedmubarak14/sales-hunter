-- ============================================================
-- Sales Hunter — initial schema (Supabase / Postgres)
-- Implements docs/INTEGRATION.md §5.
-- Identity: hunter = Zid email (case-insensitive), join key =
-- HubSpot deal ID. Amounts come from Metabase; this DB owns
-- identity + workflow, never the commission math.
-- Run in the Supabase SQL editor (or `supabase db push`).
-- ============================================================

create extension if not exists citext;
create extension if not exists pgcrypto;

-- ---------- enums ----------
create type user_role as enum ('hunter', 'management', 'finance');
create type payout_status as enum ('awaiting_calc', 'pending', 'approved', 'paid');

-- ---------- users & profiles ----------
create table app_users (
  id uuid primary key default gen_random_uuid(),
  zid_email citext unique not null,
  name text not null,
  dept text,
  title text,
  role user_role not null default 'hunter',
  active boolean not null default true,
  email_aliases citext[] not null default '{}',
  created_at timestamptz not null default now()
);

create table profiles (
  user_id uuid primary key references app_users(id) on delete cascade,
  phone text,
  personal_email citext,
  bank text,
  -- IBAN is encrypted at rest; never store or expose plaintext.
  iban_encrypted bytea,
  iban_last4 text,
  payout_method text default 'Bank transfer (payroll)',
  national_id_encrypted bytea,
  updated_at timestamptz not null default now()
);

-- ---------- HubSpot mirror ----------
create table deals (
  hubspot_deal_id text primary key,
  company text,
  hunter_email citext,
  stage text not null,
  amount_net numeric,
  currency text not null default 'SAR',
  sales_owner text,
  lost_reason text,
  unqualified_reason text,
  industry text,
  platform text,
  store_url text,
  merchant_email citext,
  merchant_phone text,
  notes text,
  hs_created_at timestamptz,
  hs_closed_at timestamptz,
  synced_at timestamptz not null default now()
);
create index deals_hunter_idx on deals (hunter_email);
create index deals_stage_idx on deals (stage);

create table deal_stage_events (
  id bigserial primary key,
  hubspot_deal_id text not null references deals(hubspot_deal_id) on delete cascade,
  from_stage text,
  to_stage text not null,
  occurred_at timestamptz not null,
  source text not null default 'webhook' -- webhook | poll | backfill
);
create index dse_deal_idx on deal_stage_events (hubspot_deal_id, occurred_at);

-- ---------- Metabase mirrors ----------
-- Q1: the commission calculation (source of truth for amounts).
create table commissions (
  id bigserial primary key,
  hubspot_deal_id text not null,
  hunter_email citext not null,
  period text not null default '',        -- from Q1 if commissions recur
  base_amount numeric,
  commission_amount numeric not null,
  currency text not null default 'SAR',
  calculated_at timestamptz,
  collected boolean,                       -- payment/collection flag from Q1
  -- workflow state owned by this app:
  workflow_status payout_status not null default 'pending',
  approved_by uuid references app_users(id),
  approved_at timestamptz,
  paid_at timestamptz,
  payout_run_id bigint,
  matched_user uuid references app_users(id), -- null = unmatched queue
  synced_at timestamptz not null default now(),
  unique (hubspot_deal_id, hunter_email, period)
);
create index commissions_hunter_idx on commissions (hunter_email);
create index commissions_status_idx on commissions (workflow_status);

-- Q2: subscriptions per store
create table subscriptions (
  store_id text primary key,
  hubspot_deal_id text,
  package text,
  billing_cycle text,
  started_at date,
  status text,                             -- active | churned | ...
  amount_net numeric,
  synced_at timestamptz not null default now()
);

-- Q3: top stores per category
create table store_showcase (
  store_id text primary key,
  name text not null,
  category text not null,
  orders_month integer,
  growth numeric,
  city text,
  blurb text,
  rank_in_category integer,
  synced_at timestamptz not null default now()
);

-- ---------- payout workflow ----------
create table payout_runs (
  id bigserial primary key,
  created_by uuid not null references app_users(id),
  period text,
  exported_at timestamptz,
  created_at timestamptz not null default now()
);

create table payslips (
  id bigserial primary key,
  commission_id bigint not null references commissions(id) on delete cascade,
  storage_path text not null,              -- Supabase Storage object key
  uploaded_by uuid not null references app_users(id),
  uploaded_at timestamptz not null default now()
);

-- ---------- audit & sync bookkeeping ----------
create table audit_log (
  id bigserial primary key,
  actor_email citext not null,
  action text not null,
  entity_type text,
  entity_id text,
  at timestamptz not null default now()
);

create table sync_state (
  source text primary key,                 -- hubspot | metabase_q1 | metabase_q2 | metabase_q3
  bookmark text,                           -- e.g. last hs_lastmodifieddate
  last_run_at timestamptz,
  last_status text,
  last_error text
);

create table settings (
  key text primary key,
  value jsonb not null
);
insert into settings (key, value) values
  ('commission_rate_display', '0.20'),     -- display only; amounts come from Metabase
  ('vat_rate_display', '0.15');

-- ============================================================
-- Helpers
-- ============================================================
create or replace function current_app_user()
returns app_users language sql stable security definer set search_path = public as $$
  select u.* from app_users u
  where u.active
    and (u.zid_email = (auth.jwt() ->> 'email')::citext
         or (auth.jwt() ->> 'email')::citext = any (u.email_aliases))
  limit 1;
$$;

create or replace function current_role_of()
returns user_role language sql stable security definer set search_path = public as $$
  select role from current_app_user();
$$;

create or replace function log_audit(p_action text, p_entity_type text, p_entity_id text)
returns void language sql security definer set search_path = public as $$
  insert into audit_log (actor_email, action, entity_type, entity_id)
  values ((auth.jwt() ->> 'email'), p_action, p_entity_type, p_entity_id);
$$;

-- IBAN: write encrypted, read masked by default; full reveal is
-- finance-only and always audit-logged.
create or replace function set_iban(p_iban text)
returns void language plpgsql security definer set search_path = public as $$
declare me app_users;
begin
  me := current_app_user();
  if me.id is null then raise exception 'no active user'; end if;
  if p_iban !~ '^SA[0-9]{22}$' then raise exception 'invalid Saudi IBAN'; end if;
  insert into profiles (user_id, iban_encrypted, iban_last4, updated_at)
  values (me.id,
          pgp_sym_encrypt(p_iban, current_setting('app.iban_key')),
          right(p_iban, 4), now())
  on conflict (user_id) do update
    set iban_encrypted = excluded.iban_encrypted,
        iban_last4 = excluded.iban_last4,
        updated_at = now();
end $$;

create or replace function reveal_iban(p_user_id uuid)
returns text language plpgsql security definer set search_path = public as $$
begin
  if current_role_of() <> 'finance' then raise exception 'finance only'; end if;
  perform log_audit('reveal_iban', 'profile', p_user_id::text);
  return pgp_sym_decrypt(
    (select iban_encrypted from profiles where user_id = p_user_id),
    current_setting('app.iban_key'));
end $$;

-- Workflow transitions (finance only), audit-logged.
create or replace function set_commission_status(p_id bigint, p_status payout_status)
returns void language plpgsql security definer set search_path = public as $$
declare me app_users;
begin
  me := current_app_user();
  if me.role <> 'finance' then raise exception 'finance only'; end if;
  update commissions set
    workflow_status = p_status,
    approved_by = case when p_status = 'approved' then me.id else approved_by end,
    approved_at = case when p_status = 'approved' then now() else approved_at end,
    paid_at     = case when p_status = 'paid' then now() else paid_at end
  where id = p_id;
  perform log_audit('commission_status:' || p_status, 'commission', p_id::text);
end $$;

-- Re-match unmatched commission rows after user/alias changes.
create or replace function rematch_commissions()
returns integer language sql security definer set search_path = public as $$
  with m as (
    update commissions c set matched_user = u.id
    from app_users u
    where c.matched_user is null
      and (u.zid_email = c.hunter_email or c.hunter_email = any (u.email_aliases))
    returning 1)
  select count(*)::integer from m;
$$;

-- ============================================================
-- Row-Level Security
-- hunters see their own rows; management sees everything;
-- finance sees money + profiles. Writes go through the
-- security-definer functions above or the service-role sync jobs.
-- ============================================================
alter table app_users enable row level security;
alter table profiles enable row level security;
alter table deals enable row level security;
alter table deal_stage_events enable row level security;
alter table commissions enable row level security;
alter table subscriptions enable row level security;
alter table store_showcase enable row level security;
alter table payout_runs enable row level security;
alter table payslips enable row level security;
alter table audit_log enable row level security;
alter table settings enable row level security;

create policy users_self_read on app_users for select
  using (zid_email = (auth.jwt() ->> 'email')::citext or current_role_of() in ('management', 'finance'));
create policy users_mgmt_write on app_users for all
  using (current_role_of() = 'management') with check (current_role_of() = 'management');

create policy profiles_self on profiles for all
  using (user_id = (select id from current_app_user()))
  with check (user_id = (select id from current_app_user()));
create policy profiles_fin_read on profiles for select
  using (current_role_of() = 'finance');

create policy deals_hunter on deals for select
  using (hunter_email = (auth.jwt() ->> 'email')::citext
         or current_role_of() in ('management', 'finance'));
create policy dse_via_deal on deal_stage_events for select
  using (exists (select 1 from deals d where d.hubspot_deal_id = deal_stage_events.hubspot_deal_id
                 and (d.hunter_email = (auth.jwt() ->> 'email')::citext
                      or current_role_of() in ('management', 'finance'))));

create policy commissions_read on commissions for select
  using (hunter_email = (auth.jwt() ->> 'email')::citext
         or current_role_of() in ('management', 'finance'));

create policy subs_staff on subscriptions for select
  using (current_role_of() in ('management', 'finance'));
create policy showcase_all on store_showcase for select using (auth.jwt() is not null);

create policy payout_runs_fin on payout_runs for all
  using (current_role_of() = 'finance') with check (current_role_of() = 'finance');
create policy payslips_fin on payslips for all
  using (current_role_of() = 'finance') with check (current_role_of() = 'finance');
create policy payslips_own on payslips for select
  using (exists (select 1 from commissions c where c.id = payslips.commission_id
                 and c.hunter_email = (auth.jwt() ->> 'email')::citext));

create policy audit_mgmt on audit_log for select
  using (current_role_of() in ('management', 'finance'));
create policy settings_read on settings for select using (auth.jwt() is not null);
create policy settings_mgmt on settings for update
  using (current_role_of() = 'management') with check (current_role_of() = 'management');
