-- ============================================================
-- 006 — management can read hunter profiles (contact, bank,
-- IBAN last-4). Decrypting the full IBAN stays finance-only via
-- reveal_iban(); this only lifts the SELECT restriction that
-- made the hunter drawer show dashes for management.
-- ============================================================

create policy profiles_mgmt_read on profiles for select
  using (current_role_of() = 'management');
