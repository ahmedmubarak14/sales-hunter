-- ============================================================
-- 009 — IBAN certificate storage
-- A hunter uploads a bank IBAN certificate; they, management, and
-- finance can view/download it. Stored in the private `iban-certs`
-- bucket (create it in the dashboard first, see docs). Files live
-- under <app_user_id>/... so storage policies can scope by owner.
-- ============================================================

alter table profiles add column if not exists iban_cert_path text;

-- save_profile gains the cert path (set together with a new IBAN).
drop function if exists save_profile(text, text, text, text, text, text);
create or replace function save_profile(
  p_name text, p_dept text, p_phone text,
  p_personal_email text, p_bank text, p_iban text,
  p_iban_cert_path text default null
) returns void language plpgsql security definer set search_path = public, extensions as $$
declare me app_users;
begin
  me := current_app_user();
  if me.id is null then raise exception 'no active user'; end if;
  update app_users set
    name = coalesce(nullif(trim(p_name), ''), name),
    dept = coalesce(nullif(trim(p_dept), ''), dept)
  where id = me.id;
  insert into profiles (user_id, phone, personal_email, bank, iban_cert_path, updated_at, onboarded_at)
  values (me.id, nullif(trim(p_phone), ''), nullif(trim(p_personal_email), ''),
          nullif(trim(p_bank), ''), nullif(trim(p_iban_cert_path), ''), now(), now())
  on conflict (user_id) do update set
    phone = coalesce(excluded.phone, profiles.phone),
    personal_email = coalesce(excluded.personal_email, profiles.personal_email),
    bank = coalesce(excluded.bank, profiles.bank),
    iban_cert_path = coalesce(excluded.iban_cert_path, profiles.iban_cert_path),
    updated_at = now(),
    onboarded_at = coalesce(profiles.onboarded_at, now());
  if nullif(trim(p_iban), '') is not null then
    perform set_iban(upper(replace(p_iban, ' ', '')));
  end if;
end $$;

revoke all on function save_profile(text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function save_profile(text, text, text, text, text, text, text) to authenticated;

-- Storage policies on the iban-certs bucket. Files are keyed by the
-- owner's app_user id in the first path segment.
create policy iban_cert_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'iban-certs'
    and (storage.foldername(name))[1] = (select id::text from current_app_user())
  );

create policy iban_cert_update on storage.objects for update to authenticated
  using (
    bucket_id = 'iban-certs'
    and (storage.foldername(name))[1] = (select id::text from current_app_user())
  );

create policy iban_cert_select on storage.objects for select to authenticated
  using (
    bucket_id = 'iban-certs'
    and (
      (storage.foldername(name))[1] = (select id::text from current_app_user())
      or (select (role in ('management','finance') or secondary_role in ('management','finance'))
          from current_app_user())
    )
  );
