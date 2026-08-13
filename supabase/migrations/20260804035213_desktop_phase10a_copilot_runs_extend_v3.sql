-- Phase 10A follow-up: use the pre-existing safety_status enum values
-- ('clear' | 'incomplete' | 'blocked') everywhere. A created run starts
-- 'incomplete'; finalize sets 'clear' on success and 'blocked' on failure.

create or replace function public.create_copilot_run(
  _organization_id uuid,
  _patient_id uuid,
  _encounter_id uuid,
  _lens text,
  _run_type text,
  _pathway_version_id uuid default null,
  _rule_set_version text default 'v1',
  _prompt_version text default 'v1',
  _json_schema_version text default 'v1',
  _provider_name text default 'disabled',
  _provider_model text default null,
  _provider_approval_ref text default null
) returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  _uid uuid := auth.uid();
  _id uuid;
  _pathway uuid := _pathway_version_id;
  _placeholder_sha text := repeat('0', 64);
begin
  if _uid is null then raise exception 'authentication required' using errcode='28000'; end if;
  if not exists (
    select 1 from public.organization_memberships
    where organization_id=_organization_id and user_id=_uid and status='active') then
    raise exception 'not a member of this organization' using errcode='42501';
  end if;
  if not exists (
    select 1 from public.patient_profiles
    where id=_patient_id and organization_id=_organization_id) then
    raise exception 'patient not found in this organization' using errcode='42501';
  end if;
  if _lens not in ('western','functional','naturopathy','tcm','biohacking','synergistic') then
    raise exception 'unknown lens' using errcode='22023';
  end if;
  if _run_type not in ('longitudinal_brief','differential_questions','lab_suggestions',
                       'protocol_draft','practitioner_brief') then
    raise exception 'unknown run_type' using errcode='22023';
  end if;

  if _pathway is null then
    select v.id into _pathway
    from public.clinical_pathway_versions v
    where v.organization_id = _organization_id and v.status = 'approved'
    order by v.created_at desc limit 1;
    if _pathway is null then
      raise exception 'no approved clinical pathway version — cannot run copilot'
        using errcode='55000';
    end if;
  end if;

  insert into public.clinical_copilot_runs
    (organization_id, patient_id, encounter_id, pathway_version_id,
     lens, run_type, status, input_snapshot, input_sha256, output_snapshot,
     output_sha256, safety_status, rule_set_version, prompt_version,
     output_schema_version, provider, model, provider_approval_ref, created_by)
  values
    (_organization_id, _patient_id, _encounter_id, _pathway,
     _lens, _run_type, 'created', '{}'::jsonb, _placeholder_sha, '{}'::jsonb,
     _placeholder_sha, 'incomplete', _rule_set_version, _prompt_version,
     _json_schema_version, _provider_name, _provider_model,
     _provider_approval_ref, _uid)
  returning id into _id;

  insert into public.audit_events
    (organization_id, actor_user_id, action, resource_type, resource_id,
     safe_message, metadata)
  values
    (_organization_id, _uid, 'copilot.run_created',
     'clinical_copilot_run', _id::text,
     'Copilot run created (draft)',
     jsonb_build_object('lens', _lens, 'runType', _run_type,
                        'providerName', _provider_name));

  return jsonb_build_object('ok', true, 'id', _id, 'status', 'created');
end;
$function$;

create or replace function public.finalize_copilot_run(
  _organization_id uuid,
  _run_id uuid,
  _input_snapshot_hash text,
  _output_hash text,
  _status text default 'completed'
) returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  _uid uuid := auth.uid();
  _r public.clinical_copilot_runs%rowtype;
begin
  if _uid is null then raise exception 'authentication required' using errcode='28000'; end if;
  if not exists (
    select 1 from public.organization_memberships
    where organization_id=_organization_id and user_id=_uid and status='active') then
    raise exception 'not a member of this organization' using errcode='42501';
  end if;

  select * into _r from public.clinical_copilot_runs where id=_run_id for update;
  if not found then raise exception 'run not found' using errcode='P0002'; end if;
  if _r.organization_id <> _organization_id then
    raise exception 'run belongs to a different tenant' using errcode='42501';
  end if;
  if _r.status not in ('created','in_progress') then
    raise exception 'only a created or in_progress run can be finalized' using errcode='55000';
  end if;
  if _status not in ('completed','failed') then
    raise exception 'invalid finalize status' using errcode='22023';
  end if;

  update public.clinical_copilot_runs
  set status = _status,
      input_sha256 = _input_snapshot_hash,
      output_sha256 = case when _status='completed' then _output_hash else output_sha256 end,
      safety_status = case when _status='completed' then 'clear' else 'blocked' end,
      completed_at = case when _status='completed' then clock_timestamp() else completed_at end,
      failed_at = case when _status='failed' then clock_timestamp() else failed_at end
  where id = _run_id;

  return jsonb_build_object('ok', true, 'id', _run_id, 'status', _status);
end;
$function$;
