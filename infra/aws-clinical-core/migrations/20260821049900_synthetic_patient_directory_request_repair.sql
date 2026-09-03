-- Aurora-compatible request-shape validation for the synthetic patient
-- directory. The prior implementation used a JSON helper that is not
-- available on the deployed engine version.

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
  _request_key_count integer;
begin
  perform clinical_private.assert_synthetic_context(
    clinical_private.organization_id(), 'clinical_data', 'workforce'
  );
  if not clinical_private.has_clinical_role(clinical_private.organization_id()) then
    raise exception using errcode = '42501', message = 'clinical_role_required';
  end if;

  select count(*)::integer into _request_key_count
  from jsonb_object_keys(_request);

  _base_query := 'select=id%2Corganization_id%2Cmrn%2Cfirst_name%2Clast_name%2Cdate_of_birth%2Csex%2Cstatus'
    || '&organization_id=eq.' || clinical_private.organization_id()::text
    || '&deleted_at=is.null&order=last_name.asc%2Cfirst_name.asc%2Cid.asc';
  _query := _request->>'query';

  if _request_key_count <> 3
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

revoke all on function clinical_compatibility.patient_profiles_v1(jsonb) from public;
grant execute on function clinical_compatibility.patient_profiles_v1(jsonb) to clinical_core_api;
