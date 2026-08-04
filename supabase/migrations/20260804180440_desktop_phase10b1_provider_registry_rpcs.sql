-- Phase 10B.1 — provider registry RPCs (register / revoke / set / get)
-- Split from 20260804180352 so the local ledger matches staging exactly.

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Register a provider. Requires platform-admin role. Rejects secret-shaped
-- strings in provider_secret_ref (belt-and-braces alongside the CHECK).
create or replace function public.register_copilot_provider(
  _provider_name text,
  _provider_kind text,
  _approved_model_allowlist jsonb,
  _approval_reference text,
  _retention_mode text,
  _key_ownership text,
  _processing_region text default null,
  _provider_secret_ref text default null,
  _baa_status_reference text default null,
  _activation_date timestamptz default null,
  _expiration_date timestamptz default null
) returns jsonb
language plpgsql security definer set search_path to '' as $function$
declare
  _uid uuid := auth.uid();
  _id uuid;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not public.is_platform_admin(_uid) then
    raise exception 'platform administrator role required' using errcode = '42501';
  end if;
  if _provider_kind not in ('openai_hipaa','anthropic_hipaa','platform_governed','synthetic_fixture') then
    raise exception 'unknown provider_kind' using errcode = '22023';
  end if;
  if _retention_mode not in ('zero','modified','standard','unspecified') then
    raise exception 'unknown retention_mode' using errcode = '22023';
  end if;
  if _key_ownership not in ('platform_governed','org_byok') then
    raise exception 'unknown key_ownership' using errcode = '22023';
  end if;
  if _provider_secret_ref is not null and _provider_secret_ref ~ '^(sk-|pk_|Bearer |eyJ)' then
    raise exception 'provider_secret_ref must be a reference, never a secret value' using errcode = '22023';
  end if;
  if length(trim(_approval_reference)) = 0 then
    raise exception 'approval_reference is required' using errcode = '22023';
  end if;
  insert into public.clinical_copilot_provider_registry (
    provider_name, provider_kind, approved_model_allowlist, approval_reference,
    retention_mode, key_ownership, processing_region, provider_secret_ref,
    baa_status_reference, activation_date, expiration_date,
    created_by, updated_by
  ) values (
    _provider_name, _provider_kind, _approved_model_allowlist, _approval_reference,
    _retention_mode, _key_ownership, _processing_region, _provider_secret_ref,
    _baa_status_reference, _activation_date, _expiration_date,
    _uid, _uid
  ) returning id into _id;
  insert into public.audit_events (
    organization_id, actor_user_id, action, resource_type, resource_id,
    safe_message, metadata
  ) values (
    (select organization_id from public.organization_memberships
      where user_id = _uid and status = 'active' limit 1),
    _uid, 'copilot.provider_registered',
    'clinical_copilot_provider_registry', _id::text,
    'Copilot provider registered',
    jsonb_build_object('providerKind', _provider_kind, 'retention', _retention_mode,
                       'keyOwnership', _key_ownership)
  );
  return jsonb_build_object('ok', true, 'id', _id);
end;
$function$;

-- Revoke a provider. Cascades every dependent org activation to revoked.
create or replace function public.revoke_copilot_provider(_provider_id uuid, _reason text)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  _uid uuid := auth.uid();
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not public.is_platform_admin(_uid) then
    raise exception 'platform administrator role required' using errcode = '42501';
  end if;
  if _reason is null or length(trim(_reason)) = 0 then
    raise exception 'revocation reason is required' using errcode = '22023';
  end if;
  update public.clinical_copilot_provider_registry
    set revocation_state = 'revoked',
        revocation_reason = _reason,
        revoked_at = coalesce(revoked_at, clock_timestamp()),
        revoked_by = coalesce(revoked_by, _uid),
        updated_by = _uid,
        updated_at = clock_timestamp()
   where id = _provider_id;
  if not found then
    raise exception 'provider not found' using errcode = 'P0002';
  end if;
  update public.clinical_copilot_org_activations
    set state = 'revoked',
        revoked_at = clock_timestamp(),
        revoked_by = _uid,
        revocation_reason = 'provider revoked: ' || _reason,
        updated_by = _uid,
        updated_at = clock_timestamp()
   where provider_registry_id = _provider_id
     and state in ('approved_for_synthetic','approved_for_phi','readiness_review');
  return jsonb_build_object('ok', true, 'id', _provider_id, 'revocation_state', 'revoked');
end;
$function$;

-- Per-org state machine transition.
create or replace function public.set_copilot_activation_state(
  _organization_id uuid,
  _provider_id uuid,
  _target_state text,
  _reason text,
  _legal_approval_reference text default null,
  _privacy_approval_reference text default null,
  _clinical_approval_reference text default null,
  _infra_approval_reference text default null,
  _retention_posture text default 'unspecified'
) returns jsonb
language plpgsql security definer set search_path to '' as $function$
declare
  _uid uuid := auth.uid();
  _current record;
  _provider record;
  _valid_transition boolean := false;
  _id uuid;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.organization_memberships om
    where om.organization_id = _organization_id and om.user_id = _uid and om.status = 'active'
      and om.role in ('owner','admin')
  ) then
    raise exception 'organization owner/admin role required' using errcode = '42501';
  end if;
  if _target_state not in ('disabled','readiness_review','approved_for_synthetic',
                            'approved_for_phi','suspended','revoked') then
    raise exception 'unknown target state' using errcode = '22023';
  end if;
  if _reason is null or length(trim(_reason)) = 0 then
    raise exception 'transition reason is required' using errcode = '22023';
  end if;
  select * into _provider from public.clinical_copilot_provider_registry where id = _provider_id;
  if not found then
    raise exception 'provider not found' using errcode = 'P0002';
  end if;
  if _provider.revocation_state = 'revoked' then
    raise exception 'provider is revoked' using errcode = '55000';
  end if;
  select * into _current from public.clinical_copilot_org_activations
    where organization_id = _organization_id and provider_registry_id = _provider_id
    order by created_at desc limit 1;

  if _current.id is null then
    _valid_transition := _target_state in ('disabled','readiness_review');
  else
    _valid_transition := case _current.state
      when 'disabled'               then _target_state in ('readiness_review')
      when 'readiness_review'       then _target_state in ('approved_for_synthetic','disabled')
      when 'approved_for_synthetic' then _target_state in ('approved_for_phi','suspended','disabled')
      when 'approved_for_phi'       then _target_state in ('suspended','revoked')
      when 'suspended'              then _target_state in ('approved_for_phi','approved_for_synthetic','revoked','disabled')
      when 'revoked'                then false
      else false
    end;
  end if;
  if not _valid_transition then
    raise exception 'illegal state transition from % to %', coalesce(_current.state,'(none)'), _target_state
      using errcode = '22023';
  end if;

  if _target_state = 'approved_for_phi' then
    if _legal_approval_reference is null or length(trim(_legal_approval_reference)) = 0
       or _privacy_approval_reference is null or length(trim(_privacy_approval_reference)) = 0
       or _clinical_approval_reference is null or length(trim(_clinical_approval_reference)) = 0
       or _infra_approval_reference is null or length(trim(_infra_approval_reference)) = 0 then
      raise exception 'approved_for_phi requires legal + privacy + clinical + infra approval references'
        using errcode = '22023';
    end if;
    if _provider.baa_status_reference is null or length(trim(_provider.baa_status_reference)) = 0 then
      raise exception 'approved_for_phi requires a BAA status reference on the provider registry row'
        using errcode = '22023';
    end if;
  end if;

  if _current.id is null then
    insert into public.clinical_copilot_org_activations (
      organization_id, provider_registry_id, state,
      legal_approval_reference, privacy_approval_reference,
      clinical_approval_reference, infra_approval_reference,
      retention_posture, activated_at, activated_by,
      created_by, updated_by
    ) values (
      _organization_id, _provider_id, _target_state,
      _legal_approval_reference, _privacy_approval_reference,
      _clinical_approval_reference, _infra_approval_reference,
      _retention_posture,
      case when _target_state in ('approved_for_synthetic','approved_for_phi') then clock_timestamp() end,
      case when _target_state in ('approved_for_synthetic','approved_for_phi') then _uid end,
      _uid, _uid
    ) returning id into _id;
  else
    update public.clinical_copilot_org_activations
      set state = _target_state,
          legal_approval_reference = coalesce(_legal_approval_reference, legal_approval_reference),
          privacy_approval_reference = coalesce(_privacy_approval_reference, privacy_approval_reference),
          clinical_approval_reference = coalesce(_clinical_approval_reference, clinical_approval_reference),
          infra_approval_reference = coalesce(_infra_approval_reference, infra_approval_reference),
          retention_posture = _retention_posture,
          activated_at = case when _target_state in ('approved_for_synthetic','approved_for_phi')
                              then coalesce(activated_at, clock_timestamp()) else activated_at end,
          activated_by = case when _target_state in ('approved_for_synthetic','approved_for_phi')
                              then coalesce(activated_by, _uid) else activated_by end,
          suspended_at = case when _target_state = 'suspended' then clock_timestamp() else suspended_at end,
          suspended_by = case when _target_state = 'suspended' then _uid else suspended_by end,
          suspension_reason = case when _target_state = 'suspended' then _reason else suspension_reason end,
          revoked_at = case when _target_state = 'revoked' then clock_timestamp() else revoked_at end,
          revoked_by = case when _target_state = 'revoked' then _uid else revoked_by end,
          revocation_reason = case when _target_state = 'revoked' then _reason else revocation_reason end,
          updated_by = _uid,
          updated_at = clock_timestamp()
     where id = _current.id
    returning id into _id;
  end if;

  insert into public.audit_events (
    organization_id, actor_user_id, action, resource_type, resource_id,
    safe_message, metadata
  ) values (
    _organization_id, _uid, 'copilot.activation_state_changed',
    'clinical_copilot_org_activation', _id::text,
    'Copilot activation state changed to ' || _target_state,
    jsonb_build_object('providerId', _provider_id, 'from', coalesce(_current.state,'(none)'),
                       'to', _target_state, 'retentionPosture', _retention_posture)
  );

  return jsonb_build_object('ok', true, 'id', _id, 'state', _target_state);
end;
$function$;

create or replace function public.get_copilot_activation(_organization_id uuid, _provider_id uuid)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  _uid uuid := auth.uid();
  _row record;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.organization_memberships
     where organization_id = _organization_id and user_id = _uid and status = 'active'
  ) then
    raise exception 'not a member of this organization' using errcode = '42501';
  end if;
  select * into _row from public.clinical_copilot_org_activations
    where organization_id = _organization_id and provider_registry_id = _provider_id
    order by created_at desc limit 1;
  if not found then
    return jsonb_build_object('state','disabled','supervisedRunsRequired',25,'supervisedRunsCompleted',0);
  end if;
  return jsonb_build_object(
    'id', _row.id, 'state', _row.state, 'retentionPosture', _row.retention_posture,
    'legalRef', _row.legal_approval_reference,
    'privacyRef', _row.privacy_approval_reference,
    'clinicalRef', _row.clinical_approval_reference,
    'infraRef', _row.infra_approval_reference,
    'activatedAt', _row.activated_at,
    'suspendedAt', _row.suspended_at,
    'revokedAt', _row.revoked_at,
    'supervisedRunsRequired', _row.supervised_runs_required,
    'supervisedRunsCompleted', _row.supervised_runs_completed
  );
end;
$function$;

revoke all on function public.register_copilot_provider(
  text, text, jsonb, text, text, text, text, text, text, timestamptz, timestamptz
) from public, anon;
revoke all on function public.revoke_copilot_provider(uuid, text) from public, anon;
revoke all on function public.set_copilot_activation_state(
  uuid, uuid, text, text, text, text, text, text, text
) from public, anon;
revoke all on function public.get_copilot_activation(uuid, uuid) from public, anon;
revoke all on function public.is_platform_admin(uuid) from public, anon;

grant execute on function public.register_copilot_provider(
  text, text, jsonb, text, text, text, text, text, text, timestamptz, timestamptz
) to authenticated, service_role;
grant execute on function public.revoke_copilot_provider(uuid, text) to authenticated, service_role;
grant execute on function public.set_copilot_activation_state(
  uuid, uuid, text, text, text, text, text, text, text
) to authenticated, service_role;
grant execute on function public.get_copilot_activation(uuid, uuid) to authenticated, service_role;
grant execute on function public.is_platform_admin(uuid) to authenticated, service_role;

comment on function public.is_platform_admin(uuid) is
  'Phase 10B.1: returns true if the user_id is in public.platform_admins. Table is empty by default; only a service_role migration inserts rows.';
comment on function public.register_copilot_provider(text, text, jsonb, text, text, text, text, text, text, timestamptz, timestamptz) is
  'Phase 10B.1: register a governed copilot provider. Requires platform-admin role. Refuses secret-shaped values.';
comment on function public.revoke_copilot_provider(uuid, text) is
  'Phase 10B.1: revoke a provider and cascade every dependent org activation to revoked state.';
comment on function public.set_copilot_activation_state(uuid, uuid, text, text, text, text, text, text, text) is
  'Phase 10B.1: per-org activation state machine. approved_for_phi requires all four approval references + a BAA status reference on the provider.';
comment on function public.get_copilot_activation(uuid, uuid) is
  'Phase 10B.1: returns the caller org''s current activation state for a provider, or disabled if none exists.';
