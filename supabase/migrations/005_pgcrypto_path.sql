-- ============================================================
-- 005 — fix IBAN encryption: pgcrypto lives in the `extensions`
-- schema on Supabase, but set_iban/reveal_iban pinned their
-- search_path to `public` only, so pgp_sym_encrypt/decrypt were
-- unresolvable at runtime ("function pgp_sym_encrypt(text, text)
-- does not exist"). Recreate both with `extensions` on the path.
-- CREATE OR REPLACE preserves the 002 ownership and grants.
-- ============================================================

create extension if not exists pgcrypto with schema extensions;

create or replace function set_iban(p_iban text)
returns void language plpgsql security definer
set search_path = public, extensions as $$
declare me app_users;
begin
  me := current_app_user();
  if me.id is null then raise exception 'no active user'; end if;
  if p_iban !~ '^SA[0-9]{22}$' then raise exception 'invalid Saudi IBAN'; end if;
  insert into profiles (user_id, iban_encrypted, iban_last4, updated_at)
  values (me.id, pgp_sym_encrypt(p_iban, iban_key()), right(p_iban, 4), now())
  on conflict (user_id) do update
    set iban_encrypted = excluded.iban_encrypted,
        iban_last4 = excluded.iban_last4,
        updated_at = now();
end $$;

create or replace function reveal_iban(p_user_id uuid)
returns text language plpgsql security definer
set search_path = public, extensions as $$
begin
  if current_role_of() <> 'finance' then raise exception 'finance only'; end if;
  perform log_audit('reveal_iban', 'profile', p_user_id::text);
  return pgp_sym_decrypt(
    (select iban_encrypted from profiles where user_id = p_user_id),
    iban_key());
end $$;
