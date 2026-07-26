-- ============================================================
-- 012 — client error reporting
-- The app posts failures here (failed uploads, API errors, uncaught
-- JS) so management can see breakage instead of hearing about it.
-- Anyone signed in may insert their own row; only management reads.
-- ============================================================

create table if not exists client_errors (
  id bigint generated always as identity primary key,
  actor_email citext not null default (auth.jwt() ->> 'email')::citext,
  message text not null,
  context text,
  page text,
  created_at timestamptz not null default now()
);

create index if not exists client_errors_created_idx on client_errors (created_at desc);

alter table client_errors enable row level security;

-- Signed-in users may only log rows stamped with their own email.
create policy client_errors_insert on client_errors for insert to authenticated
  with check (actor_email = (auth.jwt() ->> 'email')::citext);

create policy client_errors_mgmt_read on client_errors for select
  using (current_role_of() = 'management');
