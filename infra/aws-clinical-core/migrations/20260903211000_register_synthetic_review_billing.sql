-- Register the synthetic Review Queue and Billing read workspace behind the
-- Desktop compatibility boundary. Registrations begin disabled and require
-- an explicit post-migration review before activation.

create or replace function clinical_compatibility.synthetic_review_billing_v1(_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  _operation text;
  _args jsonb;
  _organization_id uuid := clinical_private.organization_id();
  _result jsonb;
begin
  perform clinical_private.assert_synthetic_context(
    _organization_id, 'clinical_data', 'workforce'
  );
  if not clinical_private.has_clinical_role(_organization_id)
    or jsonb_typeof(_request) <> 'object'
    or _request->>'kind' is distinct from 'rpc'
    or jsonb_typeof(_request->'args') <> 'object'
    or (select count(*) from jsonb_object_keys(_request)) <> 3 then
    raise exception using errcode = '42501', message = 'review_billing_access_refused';
  end if;

  _operation := _request->>'functionName';
  _args := _request->'args';

  if _operation = 'list_review_queue' then
    if (select count(*) from jsonb_object_keys(_args)) <> 1
      or not (_args ? '_organization_id')
      or _args->>'_organization_id' is distinct from _organization_id::text then
      raise exception using errcode = '22023', message = 'review_queue_request_invalid';
    end if;
    select coalesce(jsonb_agg(to_jsonb(item) order by item.created_at desc), '[]'::jsonb)
      into _result
      from clinical_core.list_review_queue(_organization_id) item;
    return _result;
  elsif _operation = 'resolve_review_queue_item' then
    if (select count(*) from jsonb_object_keys(_args)) <> 2
      or not (_args ?& array['_item_id','_note'])
      or coalesce(_args->>'_item_id','') !~
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
      or (_args->>'_note' is not null and char_length(_args->>'_note') > 500) then
      raise exception using errcode = '22023', message = 'review_queue_request_invalid';
    end if;
    return clinical_core.resolve_review_queue_item(
      (_args->>'_item_id')::uuid, nullif(_args->>'_note','')
    );
  elsif _operation = 'get_billing_workspace' then
    if (select count(*) from jsonb_object_keys(_args)) <> 7
      or not (_args ?& array[
        '_organization_id','_from','_to','_status','_practitioner_user_id','_location_id','_method'
      ])
      or _args->>'_organization_id' is distinct from _organization_id::text then
      raise exception using errcode = '22023', message = 'billing_request_invalid';
    end if;
    return clinical_core.invoke_billing_operation(_operation, _args);
  end if;

  raise exception using errcode = '0A000', message = 'review_billing_operation_not_supported';
end
$$;

revoke all on function clinical_compatibility.synthetic_review_billing_v1(jsonb) from public;
grant execute on function clinical_compatibility.synthetic_review_billing_v1(jsonb) to clinical_core_api;

insert into clinical_core.desktop_compatibility_operations(
  kind, operation_name, handler_schema, handler_function, source_sha256,
  enabled, reviewed_by_person_id, reviewed_at
)
select 'rpc', operation_name, 'clinical_compatibility', 'synthetic_review_billing_v1',
  encode(public.digest(convert_to(
    pg_get_functiondef('clinical_compatibility.synthetic_review_billing_v1(jsonb)'::regprocedure),
    'UTF8'), 'sha256'), 'hex'),
  false, null, null
from (values
  ('list_review_queue'),
  ('resolve_review_queue_item'),
  ('get_billing_workspace')
) registration(operation_name)
on conflict (kind, operation_name) do update set
  handler_schema = excluded.handler_schema,
  handler_function = excluded.handler_function,
  source_sha256 = excluded.source_sha256,
  enabled = false,
  reviewed_by_person_id = null,
  reviewed_at = null;
