-- UNREGISTERED source candidate. Not in the production migration assembly.
-- No Cognito trigger or Lambda is attached. This function is for a dedicated,
-- reviewed pre-token service role only; never grant it to clinical_core_api.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'clinical_token_binding') then
    create role clinical_token_binding nologin noinherit;
  end if;
end
$$;

grant usage on schema clinical_private to clinical_token_binding;

create function clinical_private.workforce_token_binding_for_subject(_subject text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  _person_id uuid;
  _organization_id uuid;
  _active_count bigint;
begin
  if _subject is null or _subject !~
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
  then
    return null;
  end if;

  select identity.person_id into _person_id
  from clinical_core.identities identity
  join clinical_core.persons person on person.id = identity.person_id
  where identity.identity_pool = 'workforce'
    and identity.identity_subject = _subject
    and identity.production_bound = true
    and identity.status = 'active'
    and person.status = 'active';
  if _person_id is null then return null; end if;

  select count(*), min(membership.organization_id::text)::uuid
    into _active_count, _organization_id
  from clinical_core.organization_memberships membership
  join clinical_core.organizations organization
    on organization.id = membership.organization_id
  where membership.person_id = _person_id
    and membership.status = 'active'
    and organization.status = 'active';

  -- Until a separately reviewed per-session clinic-selection contract exists,
  -- zero or multiple memberships must not yield an organization token claim.
  if _active_count <> 1 then return null; end if;

  return jsonb_build_object(
    'subject', _subject,
    'identityPool', 'workforce',
    'personId', _person_id::text,
    'organizationId', _organization_id::text,
    'identityStatus', 'active',
    'personStatus', 'active',
    'organizationStatus', 'active',
    'membershipStatus', 'active',
    'activeMembershipCount', 1,
    'productionBound', true
  );
end
$$;

revoke all on function clinical_private.workforce_token_binding_for_subject(text)
  from public, clinical_core_api;
grant execute on function clinical_private.workforce_token_binding_for_subject(text)
  to clinical_token_binding;
