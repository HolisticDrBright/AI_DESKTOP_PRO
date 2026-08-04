-- Phase 10A reconciliation — lock the copilot-run identity and input-snapshot
-- fields from creation, not from completion.
--
-- Under the previous guard, a caller could rewrite patient_id, lens,
-- rule_set_version, provider identity, or the input snapshot on a `created`
-- or `in_progress` run right up until finalize wrote the hashes. That is a
-- provenance hole: the run's own record no longer proved what it was actually
-- about. This migration:
--
--   * tightens `private.clinical_copilot_run_guard` so identity + input-side
--     fields are IMMUTABLE FROM CREATION (never change on any UPDATE), and
--     output-side fields (`output_snapshot`, `output_sha256`, `safety_status`)
--     become immutable only after completion / supersession / staleness /
--     signing;
--   * upgrades `create_copilot_run` with two new trailing parameters
--     (`_input_snapshot_hash text`, `_input_snapshot jsonb`) so the caller
--     writes the real input hash at CREATE time — no more placeholder;
--   * refuses `finalize_copilot_run` if it is passed an input hash that does
--     not match the one recorded at create.
--
-- The pre-Phase-10A 11-arg overload (patients-table) and the interim 12-arg
-- overload (placeholder hash) are dropped here so overload resolution is
-- unambiguous for the 6-arg default calls the SQL suite makes. Only the
-- 14-arg end-state remains; all defaults are preserved so 6-, 12-, 13-arg
-- callers still resolve.

create or replace function private.clinical_copilot_run_guard()
returns trigger language plpgsql set search_path to '' as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'clinical copilot runs are append-only' using errcode = '22023';
  end if;

  -- Fields that are IMMUTABLE from creation (never change on any UPDATE):
  --   organization_id, patient_id, encounter_id, pathway_version_id,
  --   lens, run_type, rule_set_version, prompt_version,
  --   output_schema_version, provider, model, provider_approval_ref,
  --   created_by, input_snapshot, input_sha256
  if new.organization_id is distinct from old.organization_id
     or new.patient_id is distinct from old.patient_id
     or new.encounter_id is distinct from old.encounter_id
     or new.pathway_version_id is distinct from old.pathway_version_id
     or new.lens is distinct from old.lens
     or new.run_type is distinct from old.run_type
     or new.rule_set_version is distinct from old.rule_set_version
     or new.prompt_version is distinct from old.prompt_version
     or new.output_schema_version is distinct from old.output_schema_version
     or new.provider is distinct from old.provider
     or new.model is distinct from old.model
     or new.provider_approval_ref is distinct from old.provider_approval_ref
     or new.created_by is distinct from old.created_by
     or new.input_snapshot is distinct from old.input_snapshot
     or new.input_sha256 is distinct from old.input_sha256 then
    raise exception 'clinical copilot run identity + input snapshot are locked from creation; use a new run to correct'
      using errcode = '22023';
  end if;

  -- Fields that become IMMUTABLE after completion:
  --   output_snapshot, output_sha256, safety_status
  if old.status in ('completed','superseded','stale','signed') then
    if new.output_snapshot is distinct from old.output_snapshot
       or new.output_sha256 is distinct from old.output_sha256
       or new.safety_status is distinct from old.safety_status then
      raise exception 'clinical copilot run output is immutable after completion'
        using errcode = '22023';
    end if;
  end if;

  return new;
end;
$function$;

drop function if exists public.create_copilot_run(
  uuid,uuid,uuid,text,text,text,text,text,text,text,text);
drop function if exists public.create_copilot_run(
  uuid,uuid,uuid,text,text,uuid,text,text,text,text,text,text);

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
  _provider_approval_ref text default null,
  _input_snapshot_hash text default null,
  _input_snapshot jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path to '' as $function$
declare
  _uid uuid := auth.uid();
  _id uuid;
  _pathway uuid := _pathway_version_id;
  _placeholder_sha text := repeat('0', 64);
  _hash text := coalesce(nullif(_input_snapshot_hash, ''), _placeholder_sha);
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

  -- Length check (input_sha256 CHECK requires length=64).
  if length(_hash) <> 64 then
    raise exception 'input_snapshot_hash must be a 64-char sha256 hex' using errcode='22023';
  end if;

  insert into public.clinical_copilot_runs
    (organization_id, patient_id, encounter_id, pathway_version_id,
     lens, run_type, status, input_snapshot, input_sha256, output_snapshot,
     output_sha256, safety_status, rule_set_version, prompt_version,
     output_schema_version, provider, model, provider_approval_ref, created_by)
  values
    (_organization_id, _patient_id, _encounter_id, _pathway,
     _lens, _run_type, 'created', _input_snapshot, _hash, '{}'::jsonb,
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
) returns jsonb
language plpgsql security definer set search_path to '' as $function$
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

  -- If a caller passes an input hash that mismatches, refuse — the input
  -- snapshot is locked from creation.
  if _input_snapshot_hash is not null
     and _input_snapshot_hash <> ''
     and _input_snapshot_hash <> _r.input_sha256 then
    raise exception 'input_snapshot_hash mismatch — input is locked from creation'
      using errcode='55000';
  end if;

  update public.clinical_copilot_runs
  set status = _status,
      output_sha256 = case when _status='completed' then _output_hash else output_sha256 end,
      safety_status = case when _status='completed' then 'clear' else 'blocked' end,
      completed_at = case when _status='completed' then clock_timestamp() else completed_at end,
      failed_at = case when _status='failed' then clock_timestamp() else failed_at end
  where id = _run_id;

  return jsonb_build_object('ok', true, 'id', _run_id, 'status', _status);
end;
$function$;
