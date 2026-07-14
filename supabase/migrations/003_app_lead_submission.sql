-- 003 — applied to the live project. Portal-submitted leads (pre-HubSpot
-- write path) insert directly with an APP- id, own-hunter only, entry stage.
create policy deals_app_insert on deals for insert to authenticated
  with check (
    hubspot_deal_id like 'APP-%'
    and hunter_email = (auth.jwt() ->> 'email')::citext
    and stage = 'New Lead'
  );

create policy dse_app_insert on deal_stage_events for insert to authenticated
  with check (
    hubspot_deal_id like 'APP-%'
    and exists (select 1 from deals d
                where d.hubspot_deal_id = deal_stage_events.hubspot_deal_id
                  and d.hunter_email = (auth.jwt() ->> 'email')::citext)
  );
