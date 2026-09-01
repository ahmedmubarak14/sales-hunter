-- ============================================================
-- 026 — deal_checker: drop the mirror, query on demand instead
--
-- Migration 025 added a deal_checker table for sync-metabase to mirror
-- the Metabase "deal checker" question into. That does not work and is
-- not worth fixing:
--
--   * The card is a catalogue of every Zid store. Three attempts to
--     traverse it inside an edge function — as JSON, as streamed CSV, and
--     as streamed CSV keeping only the interesting rows — were each
--     killed with WORKER_RESOURCE_LIMIT partway through.
--   * It would buy almost nothing anyway. Of the first 202,000 rows,
--     98.7% were "eligible for hunting", and for those the tab's answer
--     is identical to the one a domain absent from the list already gets.
--   * A partially-written mirror is actively harmful: every domain the
--     run never reached reads as "not on the list", which the tab reports
--     as Eligible. That is the one wrong answer this feature must not
--     give, and it is exactly what a killed run leaves behind.
--
-- The deal-check edge function now queries the card for the single domain
-- being asked about, the way a person filters domain_url in the Metabase
-- UI. No table, no schedule, nothing stale, and the work is proportional
-- to the question.
-- ============================================================

drop function if exists replace_deal_checker(jsonb);
drop table if exists deal_checker;
