-- Removes one dead variable declaration (`procedure_placeholder int;`) that
-- shipped with 20260805212243. No behavioural change: the variable was never
-- read or written. It is corrected in its own migration rather than by
-- editing the applied file, so the repository and the ledger agree.
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
revoke all on function public.evaluate_copilot_staging_gate(uuid,uuid,uuid,text,text) from public, anon;
grant execute on function public.evaluate_copilot_staging_gate(uuid,uuid,uuid,text,text) to authenticated;
