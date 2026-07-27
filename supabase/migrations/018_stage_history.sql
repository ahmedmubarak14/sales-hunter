-- ============================================================
-- 018 — remember that a deal was ever lost / unqualified
-- The reason cards used to tally only deals still parked in the lost or
-- unqualified stage, which disagreed with HubSpot: a deal marked lost is
-- routinely re-opened or moved to the nurturing pipeline, and HubSpot's
-- own reports key off stage history ("date entered Closed lost"), not the
-- stage the deal happens to be in today.
--
-- These hold the first time a deal entered any lost / unqualified stage
-- across the configured pipelines, taken from HubSpot's own
-- hs_v2_date_entered_<stageId> properties.
-- ============================================================

alter table deals add column if not exists entered_lost_at timestamptz;
alter table deals add column if not exists entered_unqualified_at timestamptz;
