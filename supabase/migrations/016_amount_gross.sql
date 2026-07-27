-- ============================================================
-- 016 — VAT-inclusive amounts
-- The app reports subscription value excl. VAT (what commission is
-- calculated on). Management also wants the gross figure — what the
-- merchant actually paid. Metabase's invoice card carries both
-- ("Amount Paid" vs "VAT Excluded"), so store the real gross rather
-- than deriving it from a hardcoded VAT rate: purchases can carry
-- discounts or exemptions that make net * 1.15 wrong.
-- ============================================================

alter table subscriptions add column if not exists amount_gross numeric;
alter table deals add column if not exists amount_gross numeric;
