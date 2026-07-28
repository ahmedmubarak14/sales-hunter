-- ============================================================
-- 022 — close two write paths that were wider than intended (M4, M5)
--
-- M4. profiles_self is FOR ALL over every column, so a hunter could
--     PATCH profiles directly and write arbitrary bytes into
--     iban_encrypted, bypassing set_iban()'s IBAN validation and its
--     encryption entirely. One garbage value there makes
--     pgp_sym_decrypt() raise inside get_ibans()'s all-rows query, which
--     takes out the whole finance IBAN view for every user at once — a
--     one-row denial of service against the payout workflow.
--
-- M5. Supabase email-OTP lets anyone with any mailbox create a session.
--     app_users membership gates reads, but neither INSERT policy checked
--     it: a stranger with a valid JWT could insert deals (constrained
--     only on id prefix / own email / stage — every other column, money
--     included, was free) and unbounded client_errors rows.
--
-- Column privileges compose with RLS: the policy still decides which
-- ROWS, these decide which COLUMNS. The SECURITY DEFINER RPCs
-- (save_profile, set_iban) run as the function owner, so they are
-- unaffected and remain the only way to write these fields.
--
-- Membership is tested as `(select id from current_app_user()) is not
-- null`, NOT `exists (select 1 from current_app_user())`.
-- current_app_user() is declared RETURNS app_users — a scalar composite,
-- not SETOF — so when nobody matches it still returns exactly one row,
-- of all NULLs. exists() is therefore ALWAYS true, and the first cut of
-- this migration let every stranger straight through because of it.
-- The pre-existing policies get this right by comparing a column (NULL
-- compares false); these follow that same shape.
-- ============================================================

-- ---- M4: encrypted/derived profile fields are RPC-only --------------
-- These were granted table-wide, and a column-level REVOKE does not
-- narrow a table-level grant (Postgres treats them as separate
-- privileges — the column revoke silently no-ops). So the table-level
-- write privileges come off first, then only the columns a user may
-- legitimately set for themselves go back on. SELECT is untouched:
-- reading your own row is fine, and iban_encrypted is ciphertext.
revoke insert, update on profiles from authenticated;
grant insert (user_id, phone, personal_email, bank, payout_method, onboarded_at, updated_at)
  on profiles to authenticated;
grant update (phone, personal_email, bank, payout_method, onboarded_at, updated_at)
  on profiles to authenticated;

-- ---- M5: both INSERT paths require a real program member ------------
-- Sync-owned columns are stripped from the client insert path too: a
-- hunter-submitted lead has no business declaring its own amount, sales
-- owner, or lost reason. submitLead() never sets any of these (it is
-- also dead code in live mode, where submission goes through the
-- embedded HubSpot form), so nothing legitimate loses a column.
-- Same table-level-grant caveat as profiles above: revoke the table
-- privilege, then re-grant only the columns a submitted lead may carry.
-- The client never UPDATEs deals directly (only app_users and settings),
-- so UPDATE comes off entirely rather than being re-granted.
revoke insert, update on deals from authenticated;
grant insert (hubspot_deal_id, company, hunter_email, stage, currency,
              industry, platform, store_url,
              merchant_email, merchant_phone, notes, hs_created_at)
  on deals to authenticated;

drop policy if exists deals_app_insert on deals;
create policy deals_app_insert on deals for insert with check (
  (select id from current_app_user()) is not null
  and hubspot_deal_id like 'APP-%'
  and hunter_email = ((auth.jwt() ->> 'email'))::citext
  and stage = 'New Lead'
);

drop policy if exists client_errors_insert on client_errors;
create policy client_errors_insert on client_errors for insert with check (
  (select id from current_app_user()) is not null
  and actor_email = ((auth.jwt() ->> 'email'))::citext
);
