-- ============================================================
-- 027 — make the hunter-scoped policies alias-aware
--
-- app_users has carried email_aliases since 001, and the pieces that
-- decide WHO you are already honour it: current_app_user() matches on
-- it, so does the sign-up trigger, and rematch_commissions() uses it to
-- attach commission rows. The pieces that decide WHAT YOU MAY READ
-- never did — every hunter-scoped policy compares hunter_email to the
-- JWT's email and nothing else.
--
-- So a person with two @zid.sa addresses signs in fine with either one,
-- and then cannot see the deals they raised under the other. The alias
-- looked configured and silently did half its job.
--
-- owns_hunter_email() puts the two halves back together: same alias
-- resolution current_app_user() does, asked about a row instead of a
-- session. Security definer because a hunter cannot read other rows of
-- app_users to answer it themselves; it discloses nothing beyond a
-- boolean about their own identity.
-- ============================================================

create or replace function owns_hunter_email(p_email citext)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from app_users u
    where u.active
      and (u.zid_email = (auth.jwt() ->> 'email')::citext
           or (auth.jwt() ->> 'email')::citext = any (u.email_aliases))
      and (u.zid_email = p_email or p_email = any (u.email_aliases))
  );
$$;

revoke all on function owns_hunter_email(citext) from public;
grant execute on function owns_hunter_email(citext) to authenticated;

drop policy if exists deals_hunter on deals;
create policy deals_hunter on deals for select using (
  owns_hunter_email(hunter_email)
  or has_access('management') or has_access('finance')
);

drop policy if exists commissions_read on commissions;
create policy commissions_read on commissions for select using (
  owns_hunter_email(hunter_email)
  or has_access('management') or has_access('finance')
);

drop policy if exists dse_via_deal on deal_stage_events;
create policy dse_via_deal on deal_stage_events for select using (
  exists (
    select 1 from deals d
    where d.hubspot_deal_id = deal_stage_events.hubspot_deal_id
      and (owns_hunter_email(d.hunter_email)
           or has_access('management') or has_access('finance'))
  )
);

-- 017 scoped this to own deals only, deliberately — left that way, just
-- alias-aware, so a hunter's own paid deal under either address still
-- resolves to a package and a win.
drop policy if exists subs_hunter_own on subscriptions;
create policy subs_hunter_own on subscriptions for select using (
  exists (
    select 1 from deals d
    where d.hubspot_deal_id = subscriptions.hubspot_deal_id
      and owns_hunter_email(d.hunter_email)
  )
);

-- ------------------------------------------------------------
-- The alias this was written for: Abdulmalik Ghanem raises deals under
-- both a.ghanem@zid.sa and mlk@zid.sa. Idempotent, and a no-op on any
-- database where that account does not exist.
-- ------------------------------------------------------------
update app_users
   set email_aliases = array(select distinct unnest(email_aliases || array['mlk@zid.sa']::citext[]))
 where zid_email = 'a.ghanem@zid.sa'
   and not ('mlk@zid.sa' = any (email_aliases));

-- Attach any commission rows that were left unmatched because they came
-- in under the alias. Safe to re-run; matches nothing when there are none.
select rematch_commissions();
