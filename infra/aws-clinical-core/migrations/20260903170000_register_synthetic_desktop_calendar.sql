-- Register the synthetic calendar read behind the reviewed Desktop compatibility boundary.

create or replace function clinical_compatibility.get_desktop_calendar_v1(_request jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare _args jsonb; _organization_id uuid; _from timestamptz; _to timestamptz;
begin
  perform clinical_private.assert_synthetic_context(
    clinical_private.organization_id(), 'clinical_data', 'workforce');
  if jsonb_typeof(_request) <> 'object'
    or _request->>'kind' is distinct from 'rpc'
    or _request->>'functionName' is distinct from 'get_desktop_calendar'
    or jsonb_typeof(_request->'args') <> 'object'
    or (select count(*) from jsonb_object_keys(_request)) <> 3
    or (select count(*) from jsonb_object_keys(_request->'args')) <> 3
    or not (_request->'args' ?& array['_organization_id','_from','_to']) then
    raise exception using errcode='22023',message='calendar_request_invalid';
  end if;
  _args := _request->'args';
  begin
    _organization_id := (_args->>'_organization_id')::uuid;
    _from := (_args->>'_from')::timestamptz;
    _to := (_args->>'_to')::timestamptz;
  exception when others then
    raise exception using errcode='22023',message='calendar_request_invalid';
  end;
  if _organization_id <> clinical_private.organization_id() then
    raise exception using errcode='42501',message='calendar_tenant_refused';
  end if;
  return clinical_core.get_desktop_calendar(_organization_id,_from,_to);
end $$;

revoke all on function clinical_compatibility.get_desktop_calendar_v1(jsonb) from public;
grant execute on function clinical_compatibility.get_desktop_calendar_v1(jsonb) to clinical_core_api;

insert into clinical_core.desktop_compatibility_operations(
  kind,operation_name,handler_schema,handler_function,source_sha256,
  enabled,reviewed_by_person_id,reviewed_at
) values (
  'rpc','get_desktop_calendar','clinical_compatibility','get_desktop_calendar_v1',
  '1d174327a6688b735c9f151a0da8e40920245456fd7cfb16826a1a73924f9118',
  false,null,null
)
on conflict (kind,operation_name) do update set
  handler_schema=excluded.handler_schema,
  handler_function=excluded.handler_function,
  source_sha256=excluded.source_sha256,
  enabled=false,
  reviewed_by_person_id=null,
  reviewed_at=null;
