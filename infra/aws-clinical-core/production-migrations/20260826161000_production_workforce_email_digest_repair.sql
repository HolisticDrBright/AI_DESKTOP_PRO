-- Immutable repair: security-definer functions use an empty search path, so
-- the pgcrypto digest function must be schema-qualified.

create or replace function clinical_core.add_org_member(
  _organization_id uuid,
  _email text,
  _role text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  _normalized_email text := lower(btrim(coalesce(_email,'')));
  _person_id uuid;
  _membership_id uuid;
begin
  perform clinical_private.require_organization_admin(_organization_id, false);
  if _normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or char_length(_normalized_email) > 320 then
    raise exception using errcode = '22023', message = 'membership_email_invalid';
  end if;
  if _role not in ('owner','admin','practitioner','staff','member') then
    raise exception using errcode = '22023', message = 'membership_role_invalid';
  end if;
  if _role = 'owner'
    and clinical_private.require_organization_admin(_organization_id, true) <> 'owner' then
    raise exception using errcode = '42501', message = 'owner_role_required';
  end if;

  select directory.person_id into _person_id
  from clinical_core.workforce_identity_directory directory
  join clinical_core.identities identity
    on identity.person_id = directory.person_id
   and identity.identity_pool = 'workforce'
   and identity.identity_subject = directory.identity_subject
   and identity.status = 'active'
  join clinical_core.persons person
    on person.id = directory.person_id and person.status = 'active'
  where directory.email_sha256 = encode(public.digest(_normalized_email,'sha256'),'hex')
    and directory.status = 'active';
  if _person_id is null then
    raise exception using errcode = 'P0002', message = 'workforce_identity_not_registered';
  end if;

  insert into clinical_core.organization_memberships(
    organization_id, person_id, role, status
  ) values (_organization_id, _person_id, _role, 'pending')
  on conflict (organization_id,person_id) do update
    set role = excluded.role,
        status = case
          when clinical_core.organization_memberships.status = 'active'
            then clinical_core.organization_memberships.status
          else 'pending'
        end
  returning id into _membership_id;

  insert into clinical_audit.events(
    organization_id, actor_person_id, action, resource_type, resource_id,
    purpose, safe_metadata
  ) values (
    _organization_id, clinical_private.actor_person_id(),
    'membership.role_changed', 'organization_membership', _membership_id,
    'clinical_data', jsonb_build_object('event','invited','role',_role)
  );
  return _membership_id;
end
$$;

revoke all on function clinical_core.add_org_member(uuid,text,text) from public;
grant execute on function clinical_core.add_org_member(uuid,text,text) to clinical_core_api;
