-- ============================================================
-- 015 — store_showcase: switch to all-time ranking
-- The only Metabase card available for this ("Top Stores by
-- Category") gives all-time Store ID / Name / Category / Orders
-- Count / Orders Total SAR — no monthly figures, growth%, city,
-- or blurb copy. Reshape the table to match what's actually
-- there instead of carrying columns nothing populates.
-- ============================================================

alter table store_showcase rename column orders_month to orders_count;
alter table store_showcase add column if not exists orders_total_sar numeric;
alter table store_showcase drop column if exists growth;
alter table store_showcase drop column if exists city;
alter table store_showcase drop column if exists blurb;

-- No security_invoker here on purpose: this view exists specifically so
-- hunters (blocked by store_showcase's management/finance-only RLS) can
-- still see rankings. security_invoker=true would make the view enforce
-- that same RLS and defeat the point — the view's fixed column list
-- (no orders_count/orders_total_sar) is what keeps revenue and order
-- volume hidden from hunters, not row-level security.
drop view if exists store_showcase_lite;
create view store_showcase_lite as
  select store_id, name, category, rank_in_category from store_showcase;

grant select on store_showcase_lite to authenticated;
