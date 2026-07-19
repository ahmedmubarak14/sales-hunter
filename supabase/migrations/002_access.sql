-- ============================================================
-- 002 — access model upgrades
--  * secondary_role: a user can hold a second access (e.g. a
--    finance member who also hunts). RLS needs no changes: deal,
--    commission, and payslip visibility already key off the
--    signed-in email, and role-gated policies use the primary
--    role via current_role_of().
--  * auto-provision: anyone signing in with a @zid.sa address
--    becomes an active hunter automatically, unless management
--    already created (or aliased) their account with a
--    different role.
-- ============================================================

alter table app_users add column if not exists secondary_role user_role;

create or replace function handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.email ilike '%@zid.sa' and not exists (
    select 1 from app_users
    where zid_email = new.email::citext
       or new.email::citext = any (email_aliases)
  ) then
    insert into app_users (zid_email, name, role)
    values (
      new.email,
      coalesce(
        nullif(new.raw_user_meta_data ->> 'full_name', ''),
        initcap(replace(split_part(new.email, '@', 1), '.', ' '))
      ),
      'hunter'
    );
  end if;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_auth_user();

-- Backfill: provision @zid.sa accounts that signed in before this
-- trigger existed and were never added by management.
insert into app_users (zid_email, name, role)
select u.email,
       coalesce(
         nullif(u.raw_user_meta_data ->> 'full_name', ''),
         initcap(replace(split_part(u.email, '@', 1), '.', ' '))
       ),
       'hunter'
from auth.users u
where u.email ilike '%@zid.sa'
  and not exists (
    select 1 from app_users a
    where a.zid_email = u.email::citext
       or u.email::citext = any (a.email_aliases)
  );
