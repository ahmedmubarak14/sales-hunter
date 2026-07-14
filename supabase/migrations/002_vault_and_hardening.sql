-- ============================================================
-- 002 — applied to the live project on 2026-07-14 (kept here so
-- the repo matches production).
-- 1) IBAN key moved to Supabase Vault (ALTER DATABASE SET is not
--    permitted on managed Supabase). Secret name: iban_key.
-- 2) Function grant hardening per security advisors.
-- 3) sync_state readable by staff.
-- ============================================================

-- (one-time, done via SQL editor:)
-- select vault.create_secret('<key>', 'iban_key', 'Symmetric key for IBAN encryption');

create or replace function iban_key()
returns text language sql stable security definer set search_path = public, vault as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'iban_key' limit 1;
$$;
revoke all on function iban_key() from public, anon, authenticated;

create or replace function set_iban(p_iban text)
returns void language plpgsql security definer set search_path = public as $$
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
returns text language plpgsql security definer set search_path = public as $$
begin
  if current_role_of() <> 'finance' then raise exception 'finance only'; end if;
  perform log_audit('reveal_iban', 'profile', p_user_id::text);
  return pgp_sym_decrypt(
    (select iban_encrypted from profiles where user_id = p_user_id),
    iban_key());
end $$;

revoke all on function current_app_user() from public, anon, authenticated;
revoke all on function current_role_of() from public, anon, authenticated;
revoke all on function log_audit(text, text, text) from public, anon, authenticated;
revoke all on function set_iban(text) from public, anon, authenticated;
revoke all on function reveal_iban(uuid) from public, anon, authenticated;
revoke all on function set_commission_status(bigint, payout_status) from public, anon, authenticated;
revoke all on function rematch_commissions() from public, anon, authenticated;

grant execute on function current_app_user() to authenticated;
grant execute on function current_role_of() to authenticated;
grant execute on function set_iban(text) to authenticated;
grant execute on function reveal_iban(uuid) to authenticated;
grant execute on function set_commission_status(bigint, payout_status) to authenticated;
grant execute on function rematch_commissions() to service_role;

create policy sync_state_staff on sync_state for select
  using (current_role_of() in ('management', 'finance'));
