-- ============================================================
-- 021 — two live production bugs found in the full app audit
--
-- 1. reveal_iban() / get_ibans() throw in production right now.
--    Migration 019 recreated both with `set search_path to 'public'`,
--    dropping `extensions` — pgcrypto lives in `extensions` on this
--    project (migration 005 fixed this exact issue once already), so
--    pgp_sym_decrypt() is unresolvable. Finance/management cannot read
--    any IBAN; hunters cannot read their own. Recreated with the
--    correct search_path, and `stable` dropped since both write audit
--    rows via log_audit().
--
-- 2. store_showcase_lite is readable by anon right now. Migration 003
--    revoked anon SELECT on this security-definer-style view (it
--    bypasses store_showcase's management/finance RLS by design, which
--    is exactly why the revoke matters); migration 015 dropped and
--    recreated the view without re-revoking, and Supabase's default
--    privileges re-grant anon SELECT on new public objects. Verified
--    live: an anonymous REST call with the shipped publishable key
--    returned real merchant store names, categories and ranks.
-- ============================================================

create or replace function reveal_iban(p_user_id uuid)
returns text language plpgsql security definer set search_path to 'public', 'extensions' as $$
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
language plpgsql security definer set search_path to 'public', 'extensions' as $$
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

revoke select on store_showcase_lite from anon;
