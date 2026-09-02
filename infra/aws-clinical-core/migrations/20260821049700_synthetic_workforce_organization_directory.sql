-- Allow an authenticated synthetic workforce identity to discover only its
-- own active clinic memberships. This is the bootstrap read used before the
-- Desktop can set its organization-scoping cookie.

create or replace function clinical_compatibility.list_my_organizations_v1(_request jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  _organizations jsonb;
begin
  perform clinical_private.assert_synthetic_context(
    clinical_private.organization_id(), 'clinical_data', 'workforce'
  );

  if _request is distinct from jsonb_build_object(
    'kind', 'rpc',
    'functionName', 'list_my_organizations',
    'args', '{}'::jsonb
  ) then
    raise exception using errcode = '22023', message = 'organization_directory_request_invalid';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'organization_id', organization.id,
    'name', organization.synthetic_label,
    'slug', organization.id::text,
    'role', membership.role
  ) order by organization.synthetic_label, organization.id), '[]'::jsonb)
  into _organizations
  from clinical_core.organization_memberships membership
  join clinical_core.organizations organization
    on organization.id = membership.organization_id
  where membership.person_id = clinical_private.actor_person_id()
    and membership.organization_id = clinical_private.organization_id()
    and membership.status = 'active'
    and organization.status = 'active'
    and organization.environment = 'synthetic-staging'
    and organization.data_classification = 'synthetic_only'
    and organization.contains_phi = false;

  return _organizations;
end
$$;

revoke all on function clinical_compatibility.list_my_organizations_v1(jsonb) from public;
grant execute on function clinical_compatibility.list_my_organizations_v1(jsonb) to clinical_core_api;

-- Registration remains disabled until a synthetic-environment operator binds
-- the reviewed migration to an existing synthetic reviewer identity.
insert into clinical_core.desktop_compatibility_operations(
  kind, operation_name, handler_schema, handler_function, source_sha256,
  enabled, reviewed_by_person_id, reviewed_at
) values (
  'rpc', 'list_my_organizations', 'clinical_compatibility',
  'list_my_organizations_v1',
  'a2b0520f97b4239cf40690e05543f864647fb84b659d2a4373b6f3645b2c482a',
  false, null, null
)
on conflict (kind, operation_name) do update set
  handler_schema = excluded.handler_schema,
  handler_function = excluded.handler_function,
  source_sha256 = excluded.source_sha256,
  enabled = false,
  reviewed_by_person_id = null,
  reviewed_at = null;
