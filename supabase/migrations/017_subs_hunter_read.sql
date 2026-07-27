-- ============================================================
-- 017 — let hunters read subscriptions for their own deals
-- subscriptions was management/finance-only, but the app now reads it
-- on every deal: it supplies the package name, and a real invoice is
-- what marks a deal won when sales never moved it to Closed Won. With
-- the table invisible to hunters, a hunter's own paid deal still looked
-- like open pipeline to them — no package, no win, no commission —
-- while management saw it correctly. Scoped to their own deals only,
-- matching the existing deals/commissions policies.
-- ============================================================

drop policy if exists subs_hunter_own on subscriptions;
create policy subs_hunter_own on subscriptions for select using (
  exists (
    select 1 from deals d
    where d.hubspot_deal_id = subscriptions.hubspot_deal_id
      and d.hunter_email = (auth.jwt() ->> 'email')::citext
  )
);
