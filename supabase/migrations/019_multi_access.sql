-- ============================================================
-- 019 — a user can hold any combination of the three accesses
--
-- Two problems, one fix.
--
-- 1. secondary_role capped a user at two accesses.
-- 2. More seriously, it never granted anything. Every policy asked
--    current_role_of(), which returns app_users.role and nothing else, so
--    a hunter with Management as their second access got management PAGES
--    but hunter-only DATA — a management dashboard showing only their own
--    leads, with no error to hint at it. Two live users are in exactly
--    that state today.
--
-- extra_roles replaces secondary_role, and has_access() asks "does this
-- user hold role X" across all of them. Every policy below is a
-- mechanical rewrite: each already tested for holding a role rather than
-- for being exclusively that role, so the meaning is unchanged for
-- single-access users.
-- ============================================================

alter table app_users add column if not exists extra_roles user_role[] not null default '{}'::user_role[];

update app_users
   set extra_roles = array[secondary_role]::user_role[]
 where secondary_role is not null
   and extra_roles = '{}'::user_role[];

create or replace function has_access(p user_role)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (
    select 1 from current_app_user() u
    where u.role = p or p = any (coalesce(u.extra_roles, '{}'::user_role[]))
  );
$$;
grant execute on function has_access(user_role) to authenticated;

-- ---- policies ----------------------------------------------------------
drop policy if exists users_mgmt_write on app_users;
create policy users_mgmt_write on app_users for all
  using (has_access('management')) with check (has_access('management'));

drop policy if exists users_self_read on app_users;
create policy users_self_read on app_users for select using (
  zid_email = ((auth.jwt() ->> 'email'))::citext
  or has_access('management') or has_access('finance')
);

drop policy if exists audit_mgmt on audit_log;
create policy audit_mgmt on audit_log for select
  using (has_access('management') or has_access('finance'));

drop policy if exists client_errors_mgmt_read on client_errors;
create policy client_errors_mgmt_read on client_errors for select
  using (has_access('management'));

drop policy if exists commissions_read on commissions;
create policy commissions_read on commissions for select using (
  hunter_email = ((auth.jwt() ->> 'email'))::citext
  or has_access('management') or has_access('finance')
);

drop policy if exists dse_via_deal on deal_stage_events;
create policy dse_via_deal on deal_stage_events for select using (
  exists (
    select 1 from deals d
    where d.hubspot_deal_id = deal_stage_events.hubspot_deal_id
      and (d.hunter_email = ((auth.jwt() ->> 'email'))::citext
           or has_access('management') or has_access('finance'))
  )
);

drop policy if exists deals_hunter on deals;
create policy deals_hunter on deals for select using (
  hunter_email = ((auth.jwt() ->> 'email'))::citext
  or has_access('management') or has_access('finance')
);

drop policy if exists intg_cfg_mgmt on integration_config;
create policy intg_cfg_mgmt on integration_config for all
  using (has_access('management')) with check (has_access('management'));

drop policy if exists payout_runs_fin on payout_runs;
create policy payout_runs_fin on payout_runs for all
  using (has_access('finance')) with check (has_access('finance'));

drop policy if exists payout_runs_mgmt_read on payout_runs;
create policy payout_runs_mgmt_read on payout_runs for select
  using (has_access('management'));

drop policy if exists payslips_fin on payslips;
create policy payslips_fin on payslips for all
  using (has_access('finance')) with check (has_access('finance'));

drop policy if exists payslips_mgmt_read on payslips;
create policy payslips_mgmt_read on payslips for select
  using (has_access('management'));

drop policy if exists profiles_fin_read on profiles;
create policy profiles_fin_read on profiles for select
  using (has_access('finance'));

drop policy if exists profiles_mgmt_read on profiles;
create policy profiles_mgmt_read on profiles for select
  using (has_access('management'));

drop policy if exists settings_mgmt on settings;
create policy settings_mgmt on settings for update
  using (has_access('management')) with check (has_access('management'));

drop policy if exists showcase_staff on store_showcase;
create policy showcase_staff on store_showcase for select
  using (has_access('management') or has_access('finance'));

drop policy if exists subs_staff on subscriptions;
create policy subs_staff on subscriptions for select
  using (has_access('management') or has_access('finance'));

drop policy if exists sync_state_staff on sync_state;
create policy sync_state_staff on sync_state for select
  using (has_access('management') or has_access('finance'));

-- ---- IBAN helpers ------------------------------------------------------
-- These read secondary_role directly, and `null in (...)` yields NULL
-- rather than false, so the checks were subtle as well as incomplete.
create or replace function reveal_iban(p_user_id uuid)
returns text language plpgsql stable security definer set search_path to 'public' as $$
declare me app_users;
begin
  me := current_app_user();
  if me.id is null then raise exception 'no active user'; end if;
  if not (has_access('management') or has_access('finance') or p_user_id = me.id) then
    raise exception 'not allowed';
  end if;
  perform log_audit('reveal_iban', 'profile', p_user_id::text);
  return pgp_sym_decrypt(
    (select iban_encrypted from profiles where user_id = p_user_id),
    iban_key());
end $$;

create or replace function get_ibans()
returns table (user_id uuid, iban text)
language plpgsql stable security definer set search_path to 'public' as $$
declare me app_users;
begin
  me := current_app_user();
  if me.id is null then return; end if;
  if has_access('management') or has_access('finance') then
    perform log_audit('read_ibans_all', 'profiles', me.zid_email::text);
    return query
      select p.user_id, pgp_sym_decrypt(p.iban_encrypted, iban_key())
      from profiles p where p.iban_encrypted is not null;
  else
    return query
      select p.user_id, pgp_sym_decrypt(p.iban_encrypted, iban_key())
      from profiles p where p.user_id = me.id and p.iban_encrypted is not null;
  end if;
end $$;

-- ---- storage policies --------------------------------------------------
-- These were created with `... from current_app_user() u`, which Postgres
-- stored as a pinned column list of app_users — including secondary_role,
-- so the column cannot be dropped while they exist. Recreated using
-- (current_app_user()).id, which resolves the field without pinning the
-- table's shape, so future column changes don't wedge storage access.
drop policy if exists avatar_delete on storage.objects;
create policy avatar_delete on storage.objects for delete using (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = (select (current_app_user()).id::text)
);

drop policy if exists avatar_insert on storage.objects;
create policy avatar_insert on storage.objects for insert with check (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = (select (current_app_user()).id::text)
);

drop policy if exists avatar_update on storage.objects;
create policy avatar_update on storage.objects for update using (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = (select (current_app_user()).id::text)
);

drop policy if exists iban_cert_insert on storage.objects;
create policy iban_cert_insert on storage.objects for insert with check (
  bucket_id = 'iban-certs'
  and (storage.foldername(name))[1] = (select (current_app_user()).id::text)
);

drop policy if exists iban_cert_update on storage.objects;
create policy iban_cert_update on storage.objects for update using (
  bucket_id = 'iban-certs'
  and (storage.foldername(name))[1] = (select (current_app_user()).id::text)
);

drop policy if exists iban_cert_select on storage.objects;
create policy iban_cert_select on storage.objects for select using (
  bucket_id = 'iban-certs'
  and ((storage.foldername(name))[1] = (select (current_app_user()).id::text)
       or has_access('management') or has_access('finance'))
);

alter table app_users drop column if exists secondary_role;
