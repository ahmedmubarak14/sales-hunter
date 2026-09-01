-- ============================================================
-- 025 — deal_checker: the eligibility list behind the hunter's
-- Deal Checker tab.
--
-- Source is the Metabase question "deal checker" (card 18789),
-- whose columns are domain_url / Case / store_id / package_type /
-- days_since_subscription_ended. sync-metabase mirrors it here so
-- the browser never needs the Metabase key and a check is one
-- indexed lookup rather than a card run.
--
-- The verdict is decided HERE, at sync time, not in the browser:
-- `Case` is prose written by whoever maintains the card, and
-- parsing prose in the client would mean every page load re-deriving
-- a yes/no from wording that can change under it. eligible is
-- nullable on purpose — a case value the sync cannot read as either
-- answer stays NULL, and the tab reports "needs a human check"
-- rather than inventing a verdict.
-- ============================================================

create table if not exists deal_checker (
  -- Normalised host: lower-cased, no scheme, no www., no path.
  -- Matching only works if both sides are reduced the same way, and
  -- the app's normalizeDomain() is the other half of that contract.
  domain text primary key,
  -- What the card actually said, kept verbatim for display.
  case_text text,
  -- Parsed from case_text at sync time. NULL = unrecognised wording.
  eligible boolean,
  store_id text,
  package_type text,
  days_since_subscription_ended integer,
  synced_at timestamptz not null default now()
);

comment on column deal_checker.eligible is
  'true/false parsed from case_text by sync-metabase; NULL when the wording was not recognised, which the app surfaces as "needs a human check" rather than a guess.';

alter table deal_checker enable row level security;

-- Every signed-in user may read it. This is a lookup table of store
-- eligibility, carries nothing about any hunter, and the whole point of
-- the tab is that a hunter can check a domain themselves.
drop policy if exists deal_checker_read on deal_checker;
create policy deal_checker_read on deal_checker
  for select to authenticated using (true);

-- No insert/update/delete policy: only the service role (sync-metabase)
-- writes, and it bypasses RLS. A hunter must never be able to edit the
-- list that decides whether their own lead counts.

-- Replace the whole list in one transaction. The card is a full snapshot,
-- so a domain that has dropped out of it must disappear here too —
-- upserting alone would leave a stale row behind for ever, and a stale
-- "not eligible" is a lead the hunter is wrongly told to walk away from.
create or replace function replace_deal_checker(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n integer;
begin
  -- Refuse to wipe the table on an empty payload. A card run that fails
  -- or returns nothing would otherwise silently empty the list, and an
  -- empty list reads as "every domain is eligible" — the single most
  -- expensive wrong answer this feature can give.
  if p_rows is null or jsonb_array_length(p_rows) = 0 then
    raise exception 'replace_deal_checker called with no rows; refusing to empty the list';
  end if;

  create temporary table _dc_new on commit drop as
  select
    r->>'domain'                                as domain,
    r->>'case_text'                             as case_text,
    (r->>'eligible')::boolean                   as eligible,
    r->>'store_id'                              as store_id,
    r->>'package_type'                          as package_type,
    nullif(r->>'days_since_subscription_ended','')::integer
                                                as days_since_subscription_ended
  from jsonb_array_elements(p_rows) as r
  where coalesce(r->>'domain', '') <> '';

  delete from deal_checker d where not exists (
    select 1 from _dc_new n where n.domain = d.domain
  );

  insert into deal_checker as d
    (domain, case_text, eligible, store_id, package_type, days_since_subscription_ended, synced_at)
  select domain, case_text, eligible, store_id, package_type, days_since_subscription_ended, now()
  from _dc_new
  on conflict (domain) do update set
    case_text = excluded.case_text,
    eligible = excluded.eligible,
    store_id = excluded.store_id,
    package_type = excluded.package_type,
    days_since_subscription_ended = excluded.days_since_subscription_ended,
    synced_at = excluded.synced_at;

  select count(*) into n from _dc_new;
  return n;
end;
$$;

revoke all on function replace_deal_checker(jsonb) from public, anon, authenticated;

create index if not exists deal_checker_synced_at_idx on deal_checker (synced_at desc);
