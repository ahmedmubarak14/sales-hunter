-- ============================================================
-- 011 — self-service integrations (HubSpot / Metabase)
-- Management configures integrations from the app. Non-secret
-- settings live in integration_config (management can read/write).
-- Tokens live encrypted in integration_secrets, which NO client
-- role can read — only management writes them (via save_integration)
-- and the edge functions read them (via get_integration_secret,
-- service_role only).
-- ============================================================

create table if not exists integration_config (
  name text primary key,                 -- 'hubspot' | 'metabase'
  settings jsonb not null default '{}',  -- non-secret (urls, card ids, property names)
  secret_set boolean not null default false,
  last_synced_at timestamptz,
  last_status text,
  updated_at timestamptz not null default now()
);

create table if not exists integration_secrets (
  name text primary key,
  secret_encrypted bytea not null,
  updated_at timestamptz not null default now()
);

alter table integration_config enable row level security;
alter table integration_secrets enable row level security;
-- integration_config: management may read + write settings.
create policy intg_cfg_mgmt on integration_config for all
  using (current_role_of() = 'management') with check (current_role_of() = 'management');
-- integration_secrets: no policies → unreadable/unwritable by any client
-- role; only the security-definer RPCs and service_role touch it.

-- Management saves settings + (optionally) a secret in one call. The
-- secret is encrypted with the vault key and never returned.
create or replace function save_integration(p_name text, p_settings jsonb, p_secret text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v_secret text := nullif(trim(p_secret), '');
begin
  if current_role_of() <> 'management' then raise exception 'management only'; end if;
  insert into integration_config (name, settings, updated_at)
  values (p_name, coalesce(p_settings, '{}'::jsonb), now())
  on conflict (name) do update set settings = coalesce(p_settings, integration_config.settings), updated_at = now();
  if v_secret is not null then
    insert into integration_secrets (name, secret_encrypted, updated_at)
    values (p_name, pgp_sym_encrypt(v_secret, iban_key()), now())
    on conflict (name) do update set secret_encrypted = excluded.secret_encrypted, updated_at = now();
    -- store only a last-4 hint so the UI can show WHICH key is saved
    -- without ever exposing the key itself
    update integration_config
       set secret_set = true,
           settings = settings || jsonb_build_object('secret_hint', right(v_secret, 4)),
           updated_at = now()
     where name = p_name;
  end if;
end $$;

-- Edge functions (service_role) read the decrypted secret.
create or replace function get_integration_secret(p_name text)
returns text language plpgsql security definer set search_path = public, extensions as $$
begin
  return pgp_sym_decrypt((select secret_encrypted from integration_secrets where name = p_name), iban_key());
end $$;

revoke all on function save_integration(text, jsonb, text) from public, anon, authenticated;
grant execute on function save_integration(text, jsonb, text) to authenticated;
revoke all on function get_integration_secret(text) from public, anon, authenticated;
grant execute on function get_integration_secret(text) to service_role;
