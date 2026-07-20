-- ============================================================
-- 007 — management gets read access to the finance data set
-- (payslips, payout runs) so the Payouts and Hunter Accounts
-- views render fully for them. Writes (status changes, payslip
-- uploads, IBAN reveal) remain finance-only.
-- ============================================================

create policy payslips_mgmt_read on payslips for select
  using (current_role_of() = 'management');

create policy payout_runs_mgmt_read on payout_runs for select
  using (current_role_of() = 'management');
