-- Register the already-governed V2 patient-app intake read model with the
-- synthetic Desktop compatibility boundary. The registration remains disabled
-- until a synthetic operator binds it to an approved reviewer identity.

create or replace function clinical_compatibility.get_patient_app_intake_v1(_request jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  _args jsonb;
  _organization_id_text text;
  _patient_id_text text;
  _organization_id uuid;
  _patient_id uuid;
begin
  perform clinical_private.assert_synthetic_context(
    clinical_private.organization_id(), 'clinical_data', 'workforce'
  );

  if jsonb_typeof(_request) <> 'object'
    or _request->>'kind' is distinct from 'rpc'
    or _request->>'functionName' is distinct from 'get_patient_app_intake'
    or jsonb_typeof(_request->'args') <> 'object'
    or (select count(*) from jsonb_object_keys(_request)) <> 3
    or (select count(*) from jsonb_object_keys(_request->'args')) <> 2
    or not (_request->'args' ? '_organization_id')
    or not (_request->'args' ? '_patient_id') then
    raise exception using errcode = '22023', message = 'patient_app_intake_request_invalid';
  end if;

  _args := _request->'args';
  _organization_id_text := _args->>'_organization_id';
  _patient_id_text := _args->>'_patient_id';
  if _organization_id_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or _patient_id_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception using errcode = '22023', message = 'patient_app_intake_request_invalid';
  end if;

  _organization_id := _organization_id_text::uuid;
  _patient_id := _patient_id_text::uuid;
  if _organization_id <> clinical_private.organization_id() then
    raise exception using errcode = '42501', message = 'patient_app_intake_tenant_refused';
  end if;

  return clinical_core.get_patient_app_intake(_organization_id, _patient_id);
end
$$;

revoke all on function clinical_compatibility.get_patient_app_intake_v1(jsonb) from public;
grant execute on function clinical_compatibility.get_patient_app_intake_v1(jsonb) to clinical_core_api;

insert into clinical_core.desktop_compatibility_operations(
  kind, operation_name, handler_schema, handler_function, source_sha256,
  enabled, reviewed_by_person_id, reviewed_at
) values (
  'rpc', 'get_patient_app_intake', 'clinical_compatibility',
  'get_patient_app_intake_v1',
  'c61b16f7b65a91c39cc3d1352ae7c0a53a9062f91586978b98fad3c4c000bbe3',
  false, null, null
)
on conflict (kind, operation_name) do update set
  handler_schema = excluded.handler_schema,
  handler_function = excluded.handler_function,
  source_sha256 = excluded.source_sha256,
  enabled = false,
  reviewed_by_person_id = null,
  reviewed_at = null;

