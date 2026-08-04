-- Relax the pre-existing snapshot-immutability guard so that finalize can
-- write the real hash on a created / in_progress run. Once the run is
-- completed / superseded / stale / signed, immutability re-engages (the
-- pre-existing guard + the Phase 10A `clinical_copilot_runs_immutable`
-- trigger together fire on any illegal change).

create or replace function private.clinical_copilot_run_guard()
returns trigger language plpgsql set search_path to '' as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'clinical copilot runs are append-only' using errcode = '22023';
  end if;
  if old.status in ('completed','superseded','stale','signed') then
    if new.organization_id is distinct from old.organization_id
       or new.patient_id is distinct from old.patient_id
       or new.encounter_id is distinct from old.encounter_id
       or new.pathway_version_id is distinct from old.pathway_version_id
       or new.input_snapshot is distinct from old.input_snapshot
       or new.input_sha256 is distinct from old.input_sha256
       or new.output_snapshot is distinct from old.output_snapshot
       or new.output_sha256 is distinct from old.output_sha256
       or new.safety_status is distinct from old.safety_status
       or new.model is distinct from old.model
       or new.provider is distinct from old.provider
       or new.prompt_version is distinct from old.prompt_version
       or new.output_schema_version is distinct from old.output_schema_version
       or new.created_by is distinct from old.created_by then
      raise exception 'clinical copilot snapshots are immutable after completion'
        using errcode = '22023';
    end if;
  end if;
  return new;
end;
$function$;
