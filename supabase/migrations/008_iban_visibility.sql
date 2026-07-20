-- ============================================================
-- 008 — full IBAN visibility: hunters see their own, management
-- and finance (primary or secondary access) see everyone's. The
-- app fetches them via get_ibans() at load; staff reads are
-- audit-logged. reveal_iban() widens the same way for per-row
-- use and compatibility.
-- ============================================================

create or replace function get_ibans()
returns table (user_id uuid, iban text)
language plpgsql security definer
set search_path = public, extensions as $$
declare me app_users;
begin
  me := current_app_user();
  if me.id is null then return; end if;
  if me.role in ('management', 'finance')
     or me.secondary_role in ('management', 'finance') then
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

revoke all on function get_ibans() from public, anon, authenticated;
grant execute on function get_ibans() to authenticated;

create or replace function reveal_iban(p_user_id uuid)
returns text language plpgsql security definer
set search_path = public, extensions as $$
declare me app_users;
begin
  me := current_app_user();
  if me.id is null then raise exception 'no active user'; end if;
  if not (me.role in ('management', 'finance')
          or me.secondary_role in ('management', 'finance')
          or p_user_id = me.id) then
    raise exception 'not allowed';
  end if;
  perform log_audit('reveal_iban', 'profile', p_user_id::text);
  return pgp_sym_decrypt(
    (select iban_encrypted from profiles where user_id = p_user_id),
    iban_key());
end $$;
