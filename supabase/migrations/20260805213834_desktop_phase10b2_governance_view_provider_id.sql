-- The governance view returned a provider NAME but the kill-switch RPC is
-- keyed by provider ID, so the operator surface had no correct value to
-- send. The registry row id is an internal identifier, not a credential,
-- and returning it is what makes the kill-switch control actually operable
-- from the screen that displays it.
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
    'providerId', _r.id,
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
revoke all on function public.get_copilot_governance_view(uuid) from public, anon;
grant execute on function public.get_copilot_governance_view(uuid) to authenticated;
