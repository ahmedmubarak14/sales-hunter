# Migration numbering

`002_access.sql` / `002_vault_and_hardening.sql` and `003_app_lead_submission.sql` /
`003_showcase.sql` share a numeric prefix — an early numbering mistake. Left
as-is rather than renumbered.

Alphabetical sort still resolves each pair deterministically (`002_access` <
`002_vault_and_hardening`, `003_app_lead_submission` < `003_showcase`), so
apply order is unaffected. All of these migrations are already applied to
the live project. Renaming any of them risks a local `supabase db push` (or
similar filename-driven tooling) treating a renamed file as new and
re-running it against production data — a real risk for zero benefit, since
the numbering itself causes no functional problem. New migrations should
just continue from `024_*.sql` onward.
