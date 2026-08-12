-- Phase 10B.2 RPCs. Every one is SECURITY DEFINER with a pinned empty
-- search_path, refuses anon, and is revoked from PUBLIC/anon at the end.
--
-- NOTE ON FIDELITY: this file is the SQL that was applied as migration
-- 20260805212243. One dead variable declaration in
-- `evaluate_copilot_staging_gate` (`procedure_placeholder int;`) shipped with
-- it and is removed by the follow-up migration
-- 20260805213000_desktop_phase10b2_gate_dead_declaration. The file is left as
-- it ran rather than quietly corrected, so the repository and the migration
-- ledger describe the same history.

-- ---------------------------------------------------------------- synthetic
create or replace function public.attest_synthetic_subject(
  _organization_id uuid,
  _subject_type text,
  _subject_id uuid,
  _attestation_reference text
) returns jsonb
language plpgsql security definer set search_path to '' as $fn$
declare _uid uuid := auth.uid(); _id uuid;
begin
  if _uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not exists (select 1 from public.organization_memberships m
                 where m.organization_id = _organization_id and m.user_id = _uid
                   and m.status = 'active' and m.role in ('owner','admin')) then
    raise exception 'owner or admin required' using errcode = '42501';
  end if;
  if _subject_type <> 'patient' then
    raise exception 'unsupported subject type' using errcode = '22023';
  end if;
  -- The subject must exist IN THIS ORG. A cross-tenant id cannot be
  -- attested into eligibility from outside.
  if not exists (select 1 from public.patient_profiles p
                 where p.id = _subject_id and p.organization_id = _organization_id) then
    raise exception 'subject not found in organization' using errcode = '42501';
  end if;

  insert into public.clinical_synthetic_eligibility
    (organization_id, subject_type, subject_id, attestation_reference, attested_by)
  values (_organization_id, _subject_type, _subject_id, _attestation_reference, _uid)
  returning id into _id;

  perform public.record_audit_event(
    _organization_id, 'copilot.synthetic_attested', 'synthetic_eligibility',
    _id::text, 'Subject attested as synthetic for staging verification.', null,
    jsonb_build_object('subject_type', _subject_type));

  return jsonb_build_object('id', _id, 'eligibility', 'synthetic_only');
end;
$fn$;

create or replace function public.revoke_synthetic_attestation(
  _organization_id uuid, _subject_id uuid, _reason text
) returns jsonb
language plpgsql security definer set search_path to '' as $fn$
declare _uid uuid := auth.uid(); _id uuid;
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not exists (select 1 from public.organization_memberships m
                 where m.organization_id = _organization_id and m.user_id = _uid
                   and m.status = 'active' and m.role in ('owner','admin')) then
    raise exception 'owner or admin required' using errcode = '42501';
  end if;
  if _reason is null or length(trim(_reason)) < 3 then
    raise exception 'a revocation reason is required' using errcode = '22023';
  end if;
  update public.clinical_synthetic_eligibility
     set revoked_at = now(), revoked_by = _uid, revocation_reason = _reason
   where organization_id = _organization_id and subject_id = _subject_id and revoked_at is null
  returning id into _id;
  if _id is null then
    raise exception 'no live attestation' using errcode = '22023';
  end if;
  return jsonb_build_object('id', _id, 'revoked', true);
end;
$fn$;

-- A pure LOOKUP. It reads a recorded attestation and nothing else: no name
-- heuristic, no email-domain check, no MRN pattern, no id shape.
create or replace function public.is_synthetic_eligible(
  _organization_id uuid, _subject_type text, _subject_id uuid
) returns boolean
language sql stable security definer set search_path to '' as $fn$
  select exists (
    select 1 from public.clinical_synthetic_eligibility e
    where e.organization_id = _organization_id
      and e.subject_type = _subject_type
      and e.subject_id = _subject_id
      and e.revoked_at is null
      and e.eligibility = 'synthetic_only');
$fn$;

-- ------------------------------------------------------------- activation
create or replace function public.set_copilot_activation_scope(
  _organization_id uuid,
  _provider_id uuid,
  _environment text,
  _approved_use text,
  _approved_model text,
  _scope_expires_at timestamptz,
  _reason text
) returns jsonb
language plpgsql security definer set search_path to '' as $fn$
declare _uid uuid := auth.uid(); _before jsonb; _row public.clinical_copilot_org_activations;
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not exists (select 1 from public.organization_memberships m
                 where m.organization_id = _organization_id and m.user_id = _uid
                   and m.status = 'active' and m.role in ('owner','admin')) then
    raise exception 'owner or admin required' using errcode = '42501';
  end if;
  if _reason is null or length(trim(_reason)) < 3 then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  -- Explicit, early, and by name. The CHECK constraint would refuse these
  -- anyway; refusing here means the operator gets a sentence rather than a
  -- constraint violation.
  if _environment not in ('unset','staging') then
    raise exception 'environment % is not available in this phase', _environment using errcode = '22023';
  end if;
  if _approved_use not in ('none','synthetic_staging_verification') then
    raise exception 'approved use % is not available in this phase', _approved_use using errcode = '22023';
  end if;
  if _approved_use = 'synthetic_staging_verification'
     and (_approved_model is null or length(trim(_approved_model)) = 0) then
    raise exception 'an exact approved model is required' using errcode = '22023';
  end if;
  -- The model has to be on the provider's own allowlist. Scope cannot
  -- widen what the registry approved.
  if _approved_model is not null and not exists (
      select 1 from public.clinical_copilot_provider_registry r
      where r.id = _provider_id
        and r.approved_model_allowlist ? _approved_model) then
    raise exception 'model is not on the provider allowlist' using errcode = '22023';
  end if;

  select to_jsonb(a) into _before from public.clinical_copilot_org_activations a
   where a.organization_id = _organization_id and a.provider_registry_id = _provider_id;
  if _before is null then
    raise exception 'no activation row; set the activation state first' using errcode = '22023';
  end if;

  update public.clinical_copilot_org_activations
     set environment = _environment,
         approved_use = _approved_use,
         approved_model = _approved_model,
         scope_expires_at = _scope_expires_at,
         updated_at = now(), updated_by = _uid
   where organization_id = _organization_id and provider_registry_id = _provider_id
  returning * into _row;

  insert into public.clinical_copilot_activation_history
    (organization_id, provider_registry_id, change_kind, from_state, to_state, reason, actor_user_id)
  values (_organization_id, _provider_id, 'scope_changed',
    jsonb_build_object('environment', _before->>'environment',
                       'approved_use', _before->>'approved_use',
                       'approved_model', _before->>'approved_model'),
    jsonb_build_object('environment', _environment,
                       'approved_use', _approved_use,
                       'approved_model', _approved_model),
    _reason, _uid);

  perform public.record_audit_event(
    _organization_id, 'copilot.activation_scope_changed', 'copilot_activation',
    _row.id::text, 'Copilot activation scope changed.', null,
    jsonb_build_object('environment', _environment, 'approved_use', _approved_use));

  return jsonb_build_object('id', _row.id, 'environment', _row.environment,
    'approved_use', _row.approved_use, 'approved_model', _row.approved_model,
    'scope_expires_at', _row.scope_expires_at);
end;
$fn$;

-- ------------------------------------------------------------ kill switch
create or replace function public.set_copilot_kill_switch(
  _organization_id uuid, _provider_id uuid, _engaged boolean, _reason text
) returns jsonb
language plpgsql security definer set search_path to '' as $fn$
declare _uid uuid := auth.uid(); _row public.clinical_copilot_org_activations; _was boolean;
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not exists (select 1 from public.organization_memberships m
                 where m.organization_id = _organization_id and m.user_id = _uid
                   and m.status = 'active' and m.role in ('owner','admin')) then
    raise exception 'owner or admin required' using errcode = '42501';
  end if;
  -- A reason is required in BOTH directions. Releasing a kill switch is the
  -- more consequential of the two and must not be the cheaper one to do.
  if _reason is null or length(trim(_reason)) < 3 then
    raise exception 'a reason is required' using errcode = '22023';
  end if;

  select kill_switch_engaged into _was from public.clinical_copilot_org_activations
   where organization_id = _organization_id and provider_registry_id = _provider_id;
  if _was is null then
    raise exception 'no activation row' using errcode = '22023';
  end if;

  update public.clinical_copilot_org_activations
     set kill_switch_engaged = _engaged,
         kill_switch_reason = _reason,
         kill_switch_at = now(),
         kill_switch_by = _uid,
         updated_at = now(), updated_by = _uid
   where organization_id = _organization_id and provider_registry_id = _provider_id
  returning * into _row;

  insert into public.clinical_copilot_activation_history
    (organization_id, provider_registry_id, change_kind, from_state, to_state, reason, actor_user_id)
  values (_organization_id, _provider_id,
    case when _engaged then 'kill_switch_engaged' else 'kill_switch_released' end,
    jsonb_build_object('kill_switch_engaged', _was),
    jsonb_build_object('kill_switch_engaged', _engaged), _reason, _uid);

  perform public.record_audit_event(
    _organization_id, 'copilot.kill_switch_changed', 'copilot_activation',
    _row.id::text,
    case when _engaged then 'Copilot external calls blocked by kill switch.'
         else 'Copilot kill switch released.' end,
    null, jsonb_build_object('engaged', _engaged));

  -- Historical runs are untouched by design: a kill switch stops new calls,
  -- it does not rewrite what already happened.
  return jsonb_build_object('kill_switch_engaged', _row.kill_switch_engaged,
                            'kill_switch_at', _row.kill_switch_at);
end;
$fn$;

-- ---------------------------------------------------------------- posture
create or replace function public.record_copilot_provider_posture(
  _provider_id uuid,
  _baa_status text, _baa_verified_at timestamptz,
  _zdr_mam_status text, _zdr_mam_verified_at timestamptz,
  _approved_openai_organization text, _approved_openai_project text,
  _eligible_endpoint text, _eligible_model text, _reviewer_reference text
) returns jsonb
language plpgsql security definer set search_path to '' as $fn$
declare _uid uuid := auth.uid();
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not public.is_platform_admin(_uid) then
    raise exception 'platform admin required' using errcode = '42501';
  end if;
  if _baa_status not in ('unknown','verified','expired','not_approved')
     or _zdr_mam_status not in ('unknown','verified','expired','not_approved') then
    raise exception 'invalid posture status' using errcode = '22023';
  end if;
  -- "verified" without a dated, referenced review is a claim, not a record.
  if (_baa_status = 'verified' or _zdr_mam_status = 'verified')
     and (_reviewer_reference is null or length(trim(_reviewer_reference)) < 4
          or lower(trim(_reviewer_reference)) ~ '^(n/?a|none|tbd|pending|todo|test|placeholder|unknown)$') then
    raise exception 'a verified posture requires a reviewer reference' using errcode = '22023';
  end if;

  insert into public.clinical_copilot_provider_posture as p (
    provider_registry_id, baa_status, baa_verified_at, zdr_mam_status, zdr_mam_verified_at,
    approved_openai_organization, approved_openai_project, eligible_endpoint, eligible_model,
    reviewer_reference, reviewed_by, reviewed_at)
  values (_provider_id, _baa_status, _baa_verified_at, _zdr_mam_status, _zdr_mam_verified_at,
    _approved_openai_organization, _approved_openai_project, _eligible_endpoint, _eligible_model,
    _reviewer_reference, _uid, now())
  on conflict (provider_registry_id) do update set
    baa_status = excluded.baa_status, baa_verified_at = excluded.baa_verified_at,
    zdr_mam_status = excluded.zdr_mam_status, zdr_mam_verified_at = excluded.zdr_mam_verified_at,
    approved_openai_organization = excluded.approved_openai_organization,
    approved_openai_project = excluded.approved_openai_project,
    eligible_endpoint = excluded.eligible_endpoint, eligible_model = excluded.eligible_model,
    reviewer_reference = excluded.reviewer_reference, reviewed_by = excluded.reviewed_by,
    reviewed_at = now(), updated_at = now();

  return jsonb_build_object('provider_registry_id', _provider_id,
    'baa_status', _baa_status, 'zdr_mam_status', _zdr_mam_status);
end;
$fn$;

-- ----------------------------------------------------------------- budget
create or replace function public.set_copilot_call_budget(
  _organization_id uuid, _provider_id uuid, _budget_key text,
  _max_calls integer, _max_tokens integer, _max_cost_cents integer
) returns jsonb
language plpgsql security definer set search_path to '' as $fn$
declare _uid uuid := auth.uid(); _id uuid;
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not exists (select 1 from public.organization_memberships m
                 where m.organization_id = _organization_id and m.user_id = _uid
                   and m.status = 'active' and m.role in ('owner','admin')) then
    raise exception 'owner or admin required' using errcode = '42501';
  end if;
  insert into public.clinical_copilot_call_budget
    (organization_id, provider_registry_id, budget_key, max_calls, max_tokens, max_cost_cents)
  values (_organization_id, _provider_id, _budget_key, _max_calls, _max_tokens, _max_cost_cents)
  on conflict (organization_id, provider_registry_id, budget_key) do update set
    max_calls = excluded.max_calls, max_tokens = excluded.max_tokens,
    max_cost_cents = excluded.max_cost_cents, updated_at = now()
  returning id into _id;
  return jsonb_build_object('id', _id);
end;
$fn$;

-- Atomic reserve-then-settle. The row is locked FOR UPDATE, so two
-- concurrent callers cannot both read "9 of 10 used" and both proceed. The
-- table CHECK constraints are the second line: even a bug here cannot push
-- usage past the cap, it can only abort the transaction.
create or replace function public.reserve_copilot_external_call(
  _organization_id uuid, _provider_id uuid, _budget_key text, _run_id uuid,
  _model text, _request_contract_version text, _output_schema_version text,
  _projected_input_tokens integer, _projected_output_tokens integer,
  _projected_cost_cents integer
) returns jsonb
language plpgsql security definer set search_path to '' as $fn$
declare _uid uuid := auth.uid(); _b public.clinical_copilot_call_budget; _call_id uuid;
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not exists (select 1 from public.organization_memberships m
                 where m.organization_id = _organization_id and m.user_id = _uid
                   and m.status = 'active') then
    raise exception 'organization membership required' using errcode = '42501';
  end if;

  -- The kill switch is re-read here, inside the same transaction that takes
  -- the budget slot. Checking it earlier and calling later is exactly the
  -- window an operator engaging it mid-run needs to be closed.
  if exists (select 1 from public.clinical_copilot_org_activations a
             where a.organization_id = _organization_id
               and a.provider_registry_id = _provider_id
               and a.kill_switch_engaged) then
    raise exception 'kill switch engaged' using errcode = '55000';
  end if;

  select * into _b from public.clinical_copilot_call_budget
   where organization_id = _organization_id and provider_registry_id = _provider_id
     and budget_key = _budget_key
   for update;
  if _b.id is null then
    raise exception 'no budget configured' using errcode = '22023';
  end if;
  if _b.used_calls + 1 > _b.max_calls then
    raise exception 'call budget exhausted' using errcode = '55000';
  end if;
  if _b.used_input_tokens + _b.used_output_tokens
     + coalesce(_projected_input_tokens,0) + coalesce(_projected_output_tokens,0) > _b.max_tokens then
    raise exception 'token budget exhausted' using errcode = '55000';
  end if;
  if _b.used_cost_cents + coalesce(_projected_cost_cents,0) > _b.max_cost_cents then
    raise exception 'cost budget exhausted' using errcode = '55000';
  end if;

  update public.clinical_copilot_call_budget
     set used_calls = used_calls + 1, updated_at = now()
   where id = _b.id;

  insert into public.clinical_copilot_external_calls
    (organization_id, provider_registry_id, run_id, budget_id, model,
     request_contract_version, output_schema_version, result_category)
  values (_organization_id, _provider_id, _run_id, _b.id, _model,
     _request_contract_version, _output_schema_version, 'reserved')
  returning id into _call_id;

  return jsonb_build_object('reservation_id', _call_id, 'budget_id', _b.id,
    'calls_remaining', _b.max_calls - (_b.used_calls + 1));
end;
$fn$;

create or replace function public.settle_copilot_external_call(
  _organization_id uuid, _reservation_id uuid, _provider_request_id text,
  _input_tokens integer, _output_tokens integer, _latency_ms integer,
  _result_category text, _actual_cost_cents integer
) returns jsonb
language plpgsql security definer set search_path to '' as $fn$
declare _uid uuid := auth.uid(); _c public.clinical_copilot_external_calls;
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not exists (select 1 from public.organization_memberships m
                 where m.organization_id = _organization_id and m.user_id = _uid
                   and m.status = 'active') then
    raise exception 'organization membership required' using errcode = '42501';
  end if;
  if _result_category = 'reserved' then
    raise exception 'settle requires a terminal category' using errcode = '22023';
  end if;
  select * into _c from public.clinical_copilot_external_calls
   where id = _reservation_id and organization_id = _organization_id for update;
  if _c.id is null then
    raise exception 'reservation not found' using errcode = '42501';
  end if;
  if _c.settled_at is not null then
    -- Settling twice would double-count tokens against the cap.
    raise exception 'reservation already settled' using errcode = '22023';
  end if;

  update public.clinical_copilot_external_calls
     set provider_request_id = _provider_request_id,
         input_tokens = coalesce(_input_tokens,0),
         output_tokens = coalesce(_output_tokens,0),
         latency_ms = _latency_ms,
         result_category = _result_category,
         estimated_cost_cents = coalesce(_actual_cost_cents,0),
         settled_at = now()
   where id = _reservation_id;

  update public.clinical_copilot_call_budget
     set used_input_tokens = used_input_tokens + coalesce(_input_tokens,0),
         used_output_tokens = used_output_tokens + coalesce(_output_tokens,0),
         used_cost_cents = used_cost_cents + coalesce(_actual_cost_cents,0),
         updated_at = now()
   where id = _c.budget_id;

  return jsonb_build_object('reservation_id', _reservation_id, 'settled', true);
end;
$fn$;

-- ------------------------------------------------------------------- gate
-- The single server-side authority on whether an external call may happen.
-- Returns a per-gate breakdown so the operator surface and the run path
-- read the SAME verdict rather than two implementations of it.
create or replace function public.evaluate_copilot_staging_gate(
  _organization_id uuid, _provider_id uuid, _patient_id uuid, _model text, _budget_key text
) returns jsonb
language plpgsql stable security definer set search_path to '' as $fn$
declare
  _uid uuid := auth.uid();
  _a public.clinical_copilot_org_activations;
  _r public.clinical_copilot_provider_registry;
  _b public.clinical_copilot_call_budget;
  _synthetic boolean;
  _gates jsonb := '[]'::jsonb;
  _refusal text := null;
  procedure_placeholder int;
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not exists (select 1 from public.organization_memberships m
                 where m.organization_id = _organization_id and m.user_id = _uid
                   and m.status = 'active') then
    raise exception 'organization membership required' using errcode = '42501';
  end if;

  select * into _r from public.clinical_copilot_provider_registry where id = _provider_id;
  select * into _a from public.clinical_copilot_org_activations
   where organization_id = _organization_id and provider_registry_id = _provider_id;
  select * into _b from public.clinical_copilot_call_budget
   where organization_id = _organization_id and provider_registry_id = _provider_id
     and budget_key = _budget_key;
  _synthetic := public.is_synthetic_eligible(_organization_id, 'patient', _patient_id);

  -- Ordered, and the order is the contract. The first failure is the
  -- reported refusal; later gates are still evaluated for the operator
  -- surface but cannot change the verdict.
  _gates := _gates || jsonb_build_object('gate','provider_registered','pass', _r.id is not null);
  _gates := _gates || jsonb_build_object('gate','provider_not_revoked','pass', coalesce(_r.revocation_state,'revoked') = 'not_revoked');
  _gates := _gates || jsonb_build_object('gate','provider_not_expired','pass', _r.expiration_date is null or _r.expiration_date > now());
  _gates := _gates || jsonb_build_object('gate','activation_exists','pass', _a.id is not null);
  _gates := _gates || jsonb_build_object('gate','activation_approved_for_synthetic','pass', _a.state = 'approved_for_synthetic');
  _gates := _gates || jsonb_build_object('gate','environment_staging','pass', _a.environment = 'staging');
  _gates := _gates || jsonb_build_object('gate','approved_use_synthetic_staging','pass', _a.approved_use = 'synthetic_staging_verification');
  _gates := _gates || jsonb_build_object('gate','scope_not_expired','pass', _a.scope_expires_at is null or _a.scope_expires_at > now());
  _gates := _gates || jsonb_build_object('gate','kill_switch_clear','pass', coalesce(_a.kill_switch_engaged, true) = false);
  _gates := _gates || jsonb_build_object('gate','model_matches_scope','pass', _a.approved_model is not null and _a.approved_model = _model);
  _gates := _gates || jsonb_build_object('gate','model_on_registry_allowlist','pass', coalesce(_r.approved_model_allowlist ? _model, false));
  _gates := _gates || jsonb_build_object('gate','secret_reference_present','pass', _r.provider_secret_ref is not null and length(_r.provider_secret_ref) > 0);
  _gates := _gates || jsonb_build_object('gate','subject_attested_synthetic','pass', _synthetic);
  _gates := _gates || jsonb_build_object('gate','budget_configured','pass', _b.id is not null);
  _gates := _gates || jsonb_build_object('gate','budget_calls_remaining','pass', _b.id is not null and _b.used_calls < _b.max_calls);

  select g->>'gate' into _refusal from jsonb_array_elements(_gates) g
   where (g->>'pass')::boolean is not true limit 1;

  return jsonb_build_object(
    'allowed', _refusal is null,
    'refusal', _refusal,
    'gates', _gates,
    'environment', _a.environment,
    'approved_use', _a.approved_use,
    'approved_model', _a.approved_model,
    'kill_switch_engaged', coalesce(_a.kill_switch_engaged, true),
    'calls_remaining', coalesce(_b.max_calls - _b.used_calls, 0),
    'tokens_remaining', coalesce(_b.max_tokens - (_b.used_input_tokens + _b.used_output_tokens), 0),
    'cost_cents_remaining', coalesce(_b.max_cost_cents - _b.used_cost_cents, 0));
end;
$fn$;

-- Operator read for the AI Governance surface. Presence booleans only; the
-- secret reference VALUE never leaves the server.
create or replace function public.get_copilot_governance_view(_organization_id uuid)
returns jsonb
language plpgsql stable security definer set search_path to '' as $fn$
declare _uid uuid := auth.uid(); _r public.clinical_copilot_provider_registry;
        _a public.clinical_copilot_org_activations; _p public.clinical_copilot_provider_posture;
        _b public.clinical_copilot_call_budget; _hist jsonb; _last_ok timestamptz; _last_fail text;
begin
  if _uid is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not exists (select 1 from public.organization_memberships m
                 where m.organization_id = _organization_id and m.user_id = _uid
                   and m.status = 'active') then
    raise exception 'organization membership required' using errcode = '42501';
  end if;

  select * into _r from public.clinical_copilot_provider_registry order by created_at desc limit 1;
  if _r.id is not null then
    select * into _a from public.clinical_copilot_org_activations
     where organization_id = _organization_id and provider_registry_id = _r.id;
    select * into _p from public.clinical_copilot_provider_posture where provider_registry_id = _r.id;
    select * into _b from public.clinical_copilot_call_budget
     where organization_id = _organization_id and provider_registry_id = _r.id
     order by created_at desc limit 1;
    select max(settled_at) into _last_ok from public.clinical_copilot_external_calls
     where organization_id = _organization_id and result_category = 'completed';
    select result_category into _last_fail from public.clinical_copilot_external_calls
     where organization_id = _organization_id and result_category <> 'completed'
       and settled_at is not null order by settled_at desc limit 1;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'changeKind', h.change_kind, 'reason', h.reason,
           'recordedAt', h.recorded_at, 'fromState', h.from_state, 'toState', h.to_state)
         order by h.recorded_at desc), '[]'::jsonb)
    into _hist
    from (select * from public.clinical_copilot_activation_history
           where organization_id = _organization_id order by recorded_at desc limit 25) h;

  return jsonb_build_object(
    'providerRegistered', _r.id is not null,
    'providerName', _r.provider_name,
    'providerKind', _r.provider_kind,
    'hasSecretRef', _r.provider_secret_ref is not null and length(_r.provider_secret_ref) > 0,
    'activationState', coalesce(_a.state, 'disabled'),
    'environment', coalesce(_a.environment, 'unset'),
    'approvedUse', coalesce(_a.approved_use, 'none'),
    'approvedModel', _a.approved_model,
    'scopeExpiresAt', _a.scope_expires_at,
    'killSwitchEngaged', coalesce(_a.kill_switch_engaged, false),
    'killSwitchReason', _a.kill_switch_reason,
    'killSwitchAt', _a.kill_switch_at,
    'baaStatus', coalesce(_p.baa_status, 'unknown'),
    'baaVerifiedAt', _p.baa_verified_at,
    'zdrMamStatus', coalesce(_p.zdr_mam_status, 'unknown'),
    'zdrMamVerifiedAt', _p.zdr_mam_verified_at,
    'approvedOpenaiOrganization', _p.approved_openai_organization,
    'approvedOpenaiProject', _p.approved_openai_project,
    'eligibleEndpoint', _p.eligible_endpoint,
    'eligibleModel', _p.eligible_model,
    'reviewerReference', _p.reviewer_reference,
    'reviewedAt', _p.reviewed_at,
    'maxCalls', _b.max_calls, 'usedCalls', _b.used_calls,
    'maxTokens', _b.max_tokens,
    'usedTokens', coalesce(_b.used_input_tokens,0) + coalesce(_b.used_output_tokens,0),
    'maxCostCents', _b.max_cost_cents, 'usedCostCents', _b.used_cost_cents,
    'lastSuccessfulVerificationAt', _last_ok,
    'lastFailureCategory', _last_fail,
    'history', _hist);
end;
$fn$;

revoke all on function public.attest_synthetic_subject(uuid,text,uuid,text) from public, anon;
revoke all on function public.revoke_synthetic_attestation(uuid,uuid,text) from public, anon;
revoke all on function public.is_synthetic_eligible(uuid,text,uuid) from public, anon;
revoke all on function public.set_copilot_activation_scope(uuid,uuid,text,text,text,timestamptz,text) from public, anon;
revoke all on function public.set_copilot_kill_switch(uuid,uuid,boolean,text) from public, anon;
revoke all on function public.record_copilot_provider_posture(uuid,text,timestamptz,text,timestamptz,text,text,text,text,text) from public, anon;
revoke all on function public.set_copilot_call_budget(uuid,uuid,text,integer,integer,integer) from public, anon;
revoke all on function public.reserve_copilot_external_call(uuid,uuid,text,uuid,text,text,text,integer,integer,integer) from public, anon;
revoke all on function public.settle_copilot_external_call(uuid,uuid,text,integer,integer,integer,text,integer) from public, anon;
revoke all on function public.evaluate_copilot_staging_gate(uuid,uuid,uuid,text,text) from public, anon;
revoke all on function public.get_copilot_governance_view(uuid) from public, anon;

grant execute on function public.attest_synthetic_subject(uuid,text,uuid,text) to authenticated;
grant execute on function public.revoke_synthetic_attestation(uuid,uuid,text) to authenticated;
grant execute on function public.is_synthetic_eligible(uuid,text,uuid) to authenticated;
grant execute on function public.set_copilot_activation_scope(uuid,uuid,text,text,text,timestamptz,text) to authenticated;
grant execute on function public.set_copilot_kill_switch(uuid,uuid,boolean,text) to authenticated;
grant execute on function public.record_copilot_provider_posture(uuid,text,timestamptz,text,timestamptz,text,text,text,text,text) to authenticated;
grant execute on function public.set_copilot_call_budget(uuid,uuid,text,integer,integer,integer) to authenticated;
grant execute on function public.reserve_copilot_external_call(uuid,uuid,text,uuid,text,text,text,integer,integer,integer) to authenticated;
grant execute on function public.settle_copilot_external_call(uuid,uuid,text,integer,integer,integer,text,integer) to authenticated;
grant execute on function public.evaluate_copilot_staging_gate(uuid,uuid,uuid,text,text) to authenticated;
grant execute on function public.get_copilot_governance_view(uuid) to authenticated;
