-- ============================================================
-- 023 — sync integrity (M1, M3)
--
-- M1. patchDeals() writes partial column sets, but Postgres validates
--     NOT NULL on the whole proposed row before checking for a conflict,
--     so it could not use a plain upsert without also supplying
--     deals.stage. It worked around that by SNAPSHOTTING each deal's
--     current stage and writing it back — which turns every amount/owner
--     patch into a stage write. If the webhook or an overlapping
--     sync-hubspot run changed a stage between the snapshot and the
--     write, the stale stage was restored. That does NOT self-heal: the
--     poll only re-fetches deals modified in HubSpot since its bookmark,
--     and a locally-reverted stage doesn't touch hs_lastmodifieddate, so
--     the wrong stage persists until someone edits the deal again.
--
--     Fixed with a real partial UPDATE (below) that never mentions
--     stage. UPDATE has no insert path, so the NOT NULL problem that
--     forced the upsert workaround simply doesn't arise.
--
--     Same finding, second half: sync-hubspot decided which amounts to
--     protect by reading subscriptions.hubspot_deal_id — but
--     subscriptions keeps ONE row per store (the biggest invoice's deal
--     id) while amounts are patched for EVERY invoiced deal. A store
--     with two deals therefore had its non-winning deal overwritten with
--     the HubSpot quote on each poll and re-corrected on each Metabase
--     run, flip-flopping. amount_from_metabase records ownership
--     explicitly, on exactly the rows that were written.
--
-- M3. deal_stage_events had no uniqueness at all, so any retry (a webhook
--     redelivery after a 5xx, a re-run of the poll) appended duplicates
--     permanently, inflating every stage-history read.
-- ============================================================

-- ---- M1 --------------------------------------------------------------
alter table deals add column if not exists amount_from_metabase boolean not null default false;

-- Backfill: today, every deal carrying a Metabase gross amount was
-- written by sync-metabase.
update deals set amount_from_metabase = true where amount_gross is not null;

-- Partial patch for the columns sync-metabase owns. Deliberately never
-- touches `stage` — that is the entire point. Only ever updates rows
-- that already exist; ids the warehouse knows but we don't are skipped
-- silently, exactly as the old filter did.
create or replace function patch_deal_fields(p_rows jsonb)
returns integer language plpgsql security definer set search_path to 'public' as $$
declare n integer;
begin
  update deals d set
    amount_net = case when r ? 'amount_net'
      then nullif(r->>'amount_net', '')::numeric else d.amount_net end,
    amount_gross = case when r ? 'amount_gross'
      then nullif(r->>'amount_gross', '')::numeric else d.amount_gross end,
    sales_owner = case when r ? 'sales_owner'
      then nullif(r->>'sales_owner', '') else d.sales_owner end,
    -- Ownership is claimed only when an amount was actually written, so
    -- an owner-name patch never marks a deal as Metabase-priced.
    amount_from_metabase = case when r ? 'amount_net'
      then true else d.amount_from_metabase end
  from jsonb_array_elements(p_rows) r
  where d.hubspot_deal_id = r->>'hubspot_deal_id';
  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function patch_deal_fields(jsonb) from public, anon, authenticated;
grant execute on function patch_deal_fields(jsonb) to service_role;

-- ---- M3 --------------------------------------------------------------
-- Collapse any existing duplicates before the constraint goes on (none
-- at time of writing, but this must not fail on a re-run elsewhere).
delete from deal_stage_events a using deal_stage_events b
where a.id > b.id
  and a.hubspot_deal_id = b.hubspot_deal_id
  and a.to_stage = b.to_stage
  and a.occurred_at = b.occurred_at
  and a.from_stage is not distinct from b.from_stage;

-- from_stage is nullable (the very first event for a deal has no "from"),
-- and by default Postgres treats NULLs as distinct — so a plain unique
-- index would let those repeat. NULLS NOT DISTINCT fixes that while
-- keeping this a plain COLUMN index, which matters: PostgREST's
-- on_conflict takes column names, so an expression index (e.g. over
-- coalesce(from_stage,'')) could not be referenced by the upsert that
-- relies on it.
drop index if exists deal_stage_events_dedup;
create unique index if not exists deal_stage_events_dedup
  on deal_stage_events (hubspot_deal_id, from_stage, to_stage, occurred_at) nulls not distinct;
