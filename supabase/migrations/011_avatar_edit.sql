-- ============================================================
-- 011 — user-managed profile photos (+ create missing buckets)
--  * avatar_source tracks where the photo came from:
--      'google' (auto-synced), 'custom' (uploaded), 'none' (removed).
--    The Google auto-sync only writes while source is 'google', so a
--    user's own upload or removal is never overwritten at next sign-in.
--  * avatars bucket is public (profile photos render everywhere, and
--    Google's avatar URLs are public too); writes are owner-scoped.
--  * iban-certs bucket was referenced by migration 009 but never
--    created — created here so certificate upload works.
-- ============================================================

alter table app_users add column if not exists avatar_source text not null default 'google';

-- Auto-sync from the Google identity: only when the user hasn't chosen.
create or replace function set_avatar(p_url text)
returns void language plpgsql security definer set search_path = public as $$
declare me app_users;
begin
  me := current_app_user();
  if me.id is null then return; end if;
  update app_users set avatar_url = nullif(trim(p_url), '')
   where id = me.id and avatar_source = 'google';
end $$;

-- Explicit user choice: upload (url) or remove (null).
create or replace function set_avatar_custom(p_url text)
returns void language plpgsql security definer set search_path = public as $$
declare me app_users;
begin
  me := current_app_user();
  if me.id is null then raise exception 'no active user'; end if;
  if nullif(trim(p_url), '') is null then
    update app_users set avatar_url = null, avatar_source = 'none' where id = me.id;
  else
    update app_users set avatar_url = trim(p_url), avatar_source = 'custom' where id = me.id;
  end if;
end $$;

-- Go back to the Google photo (re-synced on next load / sign-in).
create or replace function reset_avatar_to_google(p_url text)
returns void language plpgsql security definer set search_path = public as $$
declare me app_users;
begin
  me := current_app_user();
  if me.id is null then raise exception 'no active user'; end if;
  update app_users set avatar_url = nullif(trim(p_url), ''), avatar_source = 'google' where id = me.id;
end $$;

revoke all on function set_avatar(text) from public, anon, authenticated;
grant execute on function set_avatar(text) to authenticated;
revoke all on function set_avatar_custom(text) from public, anon, authenticated;
grant execute on function set_avatar_custom(text) to authenticated;
revoke all on function reset_avatar_to_google(text) from public, anon, authenticated;
grant execute on function reset_avatar_to_google(text) to authenticated;

-- ---------- buckets ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152,
        array['image/png','image/jpeg','image/jpg','image/webp','image/gif'])
on conflict (id) do nothing;

-- referenced by migration 009 but never created
insert into storage.buckets (id, name, public, file_size_limit)
values ('iban-certs', 'iban-certs', false, 10485760)
on conflict (id) do nothing;

-- Avatar files live under <app_user_id>/..., so writes are owner-scoped.
drop policy if exists avatar_insert on storage.objects;
create policy avatar_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select id::text from current_app_user()));

drop policy if exists avatar_update on storage.objects;
create policy avatar_update on storage.objects for update to authenticated
  using (bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select id::text from current_app_user()));

drop policy if exists avatar_delete on storage.objects;
create policy avatar_delete on storage.objects for delete to authenticated
  using (bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select id::text from current_app_user()));

drop policy if exists avatar_select on storage.objects;
create policy avatar_select on storage.objects for select to authenticated, anon
  using (bucket_id = 'avatars');
