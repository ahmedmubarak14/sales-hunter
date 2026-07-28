-- ============================================================
-- 020 — the remaining role checks that 019 missed
--
-- 019 moved every policy and the IBAN helpers onto has_access(), but two
-- RPCs still tested a single role in their body:
--
--   set_commission_status  me.role <> 'finance'
--   save_integration       current_role_of() <> 'management'
--
-- So a user holding Finance as an extra access got "finance only" when
-- approving a payout, and anyone holding Management as an extra access
-- would have been refused on the Integrations page the same way — the
-- exact bug 019 set out to fix, still live in the two places that raise
-- rather than filter.
-- ============================================================

create or replace function set_commission_status(p_id bigint, p_status payout_status)
returns void language plpgsql security definer set search_path to 'public' as $$
declare me app_users;
begin
  me := current_app_user();
  if not has_access('finance') then raise exception 'finance only'; end if;
  update commissions set
    workflow_status = p_status,
    approved_by = case when p_status = 'approved' then me.id else approved_by end,
    approved_at = case when p_status = 'approved' then now() else approved_at end,
    paid_at     = case when p_status = 'paid' then now() else paid_at end
  where id = p_id;
  perform log_audit('commission_status:' || p_status, 'commission', p_id::text);
end $$;

create or replace function save_integration(p_name text, p_settings jsonb, p_secret text)
returns void language plpgsql security definer set search_path to 'public', 'extensions' as $$
declare v_secret text := nullif(trim(p_secret), '');
begin
  if not has_access('management') then raise exception 'management only'; end if;
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
