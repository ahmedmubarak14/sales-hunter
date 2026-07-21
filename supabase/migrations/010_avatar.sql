-- ============================================================
-- 010 — Google profile photo
-- Store each user's avatar URL (from their Google identity) so it
-- shows across the app. The client reads the URL from its own JWT
-- at sign-in and calls set_avatar() to persist it on its own row.
-- ============================================================

alter table app_users add column if not exists avatar_url text;

create or replace function set_avatar(p_url text)
returns void language plpgsql security definer set search_path = public as $$
declare me app_users;
begin
  me := current_app_user();
  if me.id is null then return; end if;
  update app_users set avatar_url = nullif(trim(p_url), '') where id = me.id;
end $$;

revoke all on function set_avatar(text) from public, anon, authenticated;
grant execute on function set_avatar(text) to authenticated;
