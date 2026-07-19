-- ============================================================
-- 003 — store showcase privacy
-- Exact order volumes of real Zid merchants are sensitive:
-- hunters get a reduced view (no orders_month) for pitching,
-- while management/finance keep the full table. Enforced in the
-- database, not the UI.
-- ============================================================

drop policy if exists showcase_all on store_showcase;
create policy showcase_staff on store_showcase for select
  using (current_role_of() in ('management', 'finance'));

-- Definer view intentionally bypasses RLS to expose the
-- non-sensitive columns to every signed-in user.
create or replace view store_showcase_lite as
  select store_id, name, category, growth, city, blurb, rank_in_category
  from store_showcase;

grant select on store_showcase_lite to authenticated;
revoke select on store_showcase_lite from anon;
