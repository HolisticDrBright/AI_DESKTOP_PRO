-- Fail-closed AWS boundary for the legacy Desktop operation surface.
-- Each reviewed operation must be registered to a separately authored wrapper
-- with the uniform (jsonb) -> jsonb signature. The API role cannot edit the
-- registry and no operation is enabled by this migration.

create table clinical_core.desktop_compatibility_operations (
  kind text not null check (kind in ('rpc','select')),
  operation_name text not null check (operation_name ~ '^[a-z][a-z0-9_]{1,127}$'),
  handler_schema text not null check (handler_schema = 'clinical_compatibility'),
  handler_function text not null check (handler_function ~ '^[a-z][a-z0-9_]{1,127}$'),
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  enabled boolean not null default false,
  reviewed_by_person_id uuid references clinical_core.persons(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  primary key (kind, operation_name),
  check ((enabled = false) or (reviewed_by_person_id is not null and reviewed_at is not null))
);

create schema if not exists clinical_compatibility;
revoke all on schema clinical_compatibility from public, clinical_core_api;
grant usage on schema clinical_compatibility to clinical_core_api, clinical_core_migrator;
revoke all on clinical_core.desktop_compatibility_operations from public, clinical_core_api;
grant all privileges on clinical_core.desktop_compatibility_operations to clinical_core_migrator;

create or replace function clinical_private.validate_desktop_compatibility_registration()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if to_regprocedure(format('%I.%I(jsonb)', new.handler_schema, new.handler_function)) is null then
    raise exception using errcode = '22023', message = 'compatibility_handler_missing';
  end if;
  return new;
end
$$;

create trigger desktop_compatibility_registration_valid
  before insert or update on clinical_core.desktop_compatibility_operations
  for each row execute function clinical_private.validate_desktop_compatibility_registration();

create or replace function clinical_core.invoke_desktop_compatibility(
  _kind text,
  _request jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  _operation text;
  _registration clinical_core.desktop_compatibility_operations%rowtype;
  _result jsonb;
begin
  perform clinical_private.assert_synthetic_context(
    clinical_private.organization_id(), 'clinical_data', 'workforce'
  );
  if not clinical_private.has_clinical_role(clinical_private.organization_id()) then
    raise exception using errcode = '42501', message = 'clinical_role_required';
  end if;
  if _kind not in ('rpc','select') or jsonb_typeof(_request) <> 'object'
    or _request->>'kind' is distinct from _kind then
    raise exception using errcode = '22023', message = 'compatibility_request_invalid';
  end if;

  _operation := case _kind
    when 'rpc' then _request->>'functionName'
    when 'select' then _request->>'table'
  end;
  if _operation is null or _operation !~ '^[a-z][a-z0-9_]{1,127}$' then
    raise exception using errcode = '22023', message = 'compatibility_request_invalid';
  end if;
  if _kind = 'rpc'
    and _request->'args' ? '_organization_id'
    and _request->'args'->>'_organization_id' is distinct from clinical_private.organization_id()::text then
    raise exception using errcode = '42501', message = 'compatibility_tenant_refused';
  end if;
  if _kind = 'select' and position(
    'organization_id=eq.' || clinical_private.organization_id()::text
    in coalesce(_request->>'query','')
  ) = 0 then
    raise exception using errcode = '42501', message = 'compatibility_tenant_refused';
  end if;

  select * into _registration
  from clinical_core.desktop_compatibility_operations o
  where o.kind = _kind and o.operation_name = _operation and o.enabled = true;
  if not found then
    raise exception using errcode = '42501', message = 'compatibility_operation_not_ported';
  end if;

  execute format('select %I.%I($1)', _registration.handler_schema, _registration.handler_function)
    using _request into _result;
  return _result;
end
$$;

revoke all on function clinical_private.validate_desktop_compatibility_registration() from public, clinical_core_api;
revoke all on function clinical_core.invoke_desktop_compatibility(text, jsonb) from public;
grant execute on function clinical_core.invoke_desktop_compatibility(text, jsonb) to clinical_core_api;

