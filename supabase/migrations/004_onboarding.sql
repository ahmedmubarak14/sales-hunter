-- ============================================================
-- 004 — hunter onboarding
-- Hunters must complete their profile (name, department, mobile,
-- personal email, bank, IBAN) before using the app. save_profile
-- is the single write path: it updates the user's own identity
-- fields, upserts the profile, encrypts the IBAN through the
-- existing set_iban(), and stamps onboarded_at the first time.
-- ============================================================

alter table profiles add column if not exists onboarded_at timestamptz;

create or replace function save_profile(
  p_name text, p_dept text, p_phone text,
  p_personal_email text, p_bank text, p_iban text
) returns void language plpgsql security definer set search_path = public as $$
declare me app_users;
begin
  me := current_app_user();
  if me.id is null then raise exception 'no active user'; end if;
  update app_users set
    name = coalesce(nullif(trim(p_name), ''), name),
    dept = coalesce(nullif(trim(p_dept), ''), dept)
  where id = me.id;
  insert into profiles (user_id, phone, personal_email, bank, updated_at, onboarded_at)
  values (me.id, nullif(trim(p_phone), ''), nullif(trim(p_personal_email), ''),
          nullif(trim(p_bank), ''), now(), now())
  on conflict (user_id) do update set
    phone = coalesce(excluded.phone, profiles.phone),
    personal_email = coalesce(excluded.personal_email, profiles.personal_email),
    bank = coalesce(excluded.bank, profiles.bank),
    updated_at = now(),
    onboarded_at = coalesce(profiles.onboarded_at, now());
  if nullif(trim(p_iban), '') is not null then
    perform set_iban(upper(replace(p_iban, ' ', '')));
  end if;
end $$;

revoke all on function save_profile(text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function save_profile(text, text, text, text, text, text) to authenticated;
