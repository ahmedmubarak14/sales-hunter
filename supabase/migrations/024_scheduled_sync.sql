-- Both sync-hubspot and sync-metabase are documented as periodic polls
-- ("hourly reconciliation poll") but nothing in this project ever
-- actually invoked them on a schedule — no pg_cron job, no Vercel cron,
-- no GitHub Action. Every prior successful sync in production was a
-- manual invocation during development/testing. Leads created in
-- HubSpot between manual runs never appeared in the app (found live:
-- two leads sat unsynced for over two days). This schedules both
-- functions to run every 15 minutes via pg_cron + pg_net, so new leads
-- and Metabase corrections show up promptly without anyone remembering
-- to trigger a sync by hand.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- The anon key is safe to embed here — it's the same public key already
-- shipped in the frontend bundle. Both functions are deployed with
-- verify_jwt disabled (they're meant to be invoked by a scheduler, not a
-- signed-in user) and only ever read HubSpot/Metabase using credentials
-- they hold server-side, so no privileged secret needs to travel through
-- this job's HTTP call.
select cron.schedule(
  'sync-hubspot-every-15-min',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://wwzvwjdhuvdieejmzqpi.supabase.co/functions/v1/sync-hubspot',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind3enZ3amRodXZkaWVlam16cXBpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwMTIwMDMsImV4cCI6MjA5OTU4ODAwM30.TjQdOW-UjPodhTNM_M4kvKMV4nSGph9NC4uJJIHIubY',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind3enZ3amRodXZkaWVlam16cXBpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwMTIwMDMsImV4cCI6MjA5OTU4ODAwM30.TjQdOW-UjPodhTNM_M4kvKMV4nSGph9NC4uJJIHIubY'
    ),
    body := '{}'::jsonb
  ) as request_id;
  $$
);

select cron.schedule(
  'sync-metabase-every-15-min',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://wwzvwjdhuvdieejmzqpi.supabase.co/functions/v1/sync-metabase',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind3enZ3amRodXZkaWVlam16cXBpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwMTIwMDMsImV4cCI6MjA5OTU4ODAwM30.TjQdOW-UjPodhTNM_M4kvKMV4nSGph9NC4uJJIHIubY',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind3enZ3amRodXZkaWVlam16cXBpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwMTIwMDMsImV4cCI6MjA5OTU4ODAwM30.TjQdOW-UjPodhTNM_M4kvKMV4nSGph9NC4uJJIHIubY'
    ),
    body := '{}'::jsonb
  ) as request_id;
  $$
);
