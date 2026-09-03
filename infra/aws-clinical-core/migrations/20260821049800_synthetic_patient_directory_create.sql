-- Synthetic-only patient directory and anonymous chart creation for Desktop.
-- The compatibility shape matches the Desktop patient adapter, but no direct
-- identifier or clinical payload is accepted or stored in this environment.

create table clinical_audit.synthetic_patient_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null references clinical_core.patient_records(id),
  actor_person_id uuid not null references clinical_core.persons(id),
  action text not null check (action = 'synthetic_patient.created'),
  safe_metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default clock_timestamp(),
  check (jsonb_typeof(safe_metadata) = 'object'),
  check (not (safe_metadata ?| array[
    'email','name','phone','date_of_birth','dob','token','token_hash',
    'raw_reason','authorization','cookie','payload']))
);
create index synthetic_patient_events_org_time_idx
  on clinical_audit.synthetic_patient_events(organization_id, occurred_at desc);
revoke all on clinical_audit.synthetic_patient_events from public, clinical_core_api;
create trigger synthetic_patient_events_append_only
  before update or delete on clinical_audit.synthetic_patient_events
  for each row execute function clinical_private.block_update_delete();

create or replace function clinical_compatibility.patient_profiles_v1(_request jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  _base_query text;
  _query text;
  _patient_id_text text;
  _patient_id uuid;
  _profiles jsonb;
begin
  perform clinical_private.assert_synthetic_context(
    clinical_private.organization_id(), 'clinical_data', 'workforce'
  );
  if not clinical_private.has_clinical_role(clinical_private.organization_id()) then
    raise exception using errcode = '42501', message = 'clinical_role_required';
  end if;

  _base_query := 'select=id%2Corganization_id%2Cmrn%2Cfirst_name%2Clast_name%2Cdate_of_birth%2Csex%2Cstatus'
    || '&organization_id=eq.' || clinical_private.organization_id()::text
    || '&deleted_at=is.null&order=last_name.asc%2Cfirst_name.asc%2Cid.asc';
  _query := _request->>'query';

  if jsonb_object_length(_request) <> 3
    or _request->>'kind' is distinct from 'select'
    or _request->>'table' is distinct from 'patient_profiles'
    or (_query <> _base_query and _query !~ ('^' || replace(_base_query, '.', '\.')
      || '&id=eq\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}&limit=1$')) then
    raise exception using errcode = '22023', message = 'patient_directory_request_invalid';
  end if;

  if _query <> _base_query then
    _patient_id_text := substring(_query from '&id=eq\.([0-9a-f-]{36})&limit=1$');
    if _patient_id_text is null then
      raise exception using errcode = '22023', message = 'patient_directory_request_invalid';
    end if;
    _patient_id := _patient_id_text::uuid;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', patient.id,
    'organization_id', patient.organization_id,
    'mrn', patient.synthetic_record_key,
    'first_name', 'Synthetic',
    'last_name', patient.synthetic_record_key,
    'date_of_birth', null,
    'sex', null,
    'status', patient.status
  ) order by patient.synthetic_record_key, patient.id), '[]'::jsonb)
  into _profiles
  from clinical_core.patient_records patient
  where patient.organization_id = clinical_private.organization_id()
    and patient.status = 'active'
    and patient.data_classification = 'synthetic_only'
    and patient.contains_phi = false
    and (_patient_id is null or patient.id = _patient_id);

  return _profiles;
end
$$;

create or replace function clinical_compatibility.create_patient_profile_v1(_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _patient clinical_core.patient_records%rowtype;
  _expected jsonb;
begin
  perform clinical_private.assert_synthetic_context(
    clinical_private.organization_id(), 'clinical_data', 'workforce'
  );
  if not clinical_private.has_clinical_role(clinical_private.organization_id()) then
    raise exception using errcode = '42501', message = 'clinical_role_required';
  end if;

  _expected := jsonb_build_object(
    'kind', 'rpc',
    'functionName', 'create_patient_profile',
    'args', jsonb_build_object(
      '_organization_id', clinical_private.organization_id(),
      '_first_name', 'Synthetic',
      '_last_name', 'link-test',
      '_date_of_birth', null,
      '_sex', 'unknown',
      '_mrn', null,
      '_email', null,
      '_phone', null
    )
  );
  if _request is distinct from _expected then
    raise exception using errcode = '22023', message = 'synthetic_patient_request_invalid';
  end if;

  insert into clinical_core.patient_records(
    organization_id, synthetic_record_key, data_classification, contains_phi, status
  ) values (
    clinical_private.organization_id(),
    'patient_syn_link_' || substring(replace(gen_random_uuid()::text, '-', '') from 1 for 12),
    'synthetic_only', false, 'active'
  ) returning * into _patient;

  insert into clinical_audit.synthetic_patient_events(
    organization_id, patient_record_id, actor_person_id, action, safe_metadata
  ) values (
    _patient.organization_id,
    _patient.id,
    clinical_private.actor_person_id(),
    'synthetic_patient.created',
    jsonb_build_object('source', 'desktop', 'classification', 'synthetic_only')
  );

  return jsonb_build_object(
    'id', _patient.id,
    'organization_id', _patient.organization_id,
    'mrn', _patient.synthetic_record_key,
    'first_name', 'Synthetic',
    'last_name', _patient.synthetic_record_key,
    'date_of_birth', null,
    'sex', null,
    'status', _patient.status
  );
end
$$;

revoke all on function clinical_compatibility.patient_profiles_v1(jsonb) from public;
revoke all on function clinical_compatibility.create_patient_profile_v1(jsonb) from public;
grant execute on function clinical_compatibility.patient_profiles_v1(jsonb) to clinical_core_api;
grant execute on function clinical_compatibility.create_patient_profile_v1(jsonb) to clinical_core_api;

-- Registrations remain disabled until a synthetic-environment operator binds
-- this reviewed migration to an existing synthetic reviewer identity.
insert into clinical_core.desktop_compatibility_operations(
  kind, operation_name, handler_schema, handler_function, source_sha256,
  enabled, reviewed_by_person_id, reviewed_at
) values
  ('select', 'patient_profiles', 'clinical_compatibility', 'patient_profiles_v1',
   '78d55529fdd5ffce0b3d908eaaf39720c6df9fcabb977c6492f65c0ef5bb468d',
   false, null, null),
  ('rpc', 'create_patient_profile', 'clinical_compatibility', 'create_patient_profile_v1',
   'e26a0b31b7cd3b47f72acf2877d633a5ce6b02ca2a4a5866af9d93082d9456ac',
   false, null, null)
on conflict (kind, operation_name) do update set
  handler_schema = excluded.handler_schema,
  handler_function = excluded.handler_function,
  source_sha256 = excluded.source_sha256,
  enabled = false,
  reviewed_by_person_id = null,
  reviewed_at = null;
