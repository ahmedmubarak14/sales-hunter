-- ============================================================
-- 014 — deals.extra: holds whatever additional HubSpot deal
-- properties the user lists under "Extra properties to capture"
-- on the Integrations page. Keyed by the HubSpot internal
-- property name, so it stays correct as that list changes.
-- ============================================================

alter table deals add column if not exists extra jsonb not null default '{}'::jsonb;
