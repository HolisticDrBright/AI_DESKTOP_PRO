-- Production workforce organization directory and administration.
-- Identity creation/invitation by email is deliberately absent: workforce
-- identities must be bound through the separately approved Cognito process.

alter table clinical_audit.events drop constraint events_action_check;
alter table clinical_audit.events add constraint events_action_check check (action in (
  'connection.invitation_issued','connection.invitation_claimed',
  'consent.granted','consent.revoked','lab_import.received',
  'lab_import.duplicate','lab_import.accepted','lab_import.rejected',
  'clinical_record.received','clinical_record.duplicate','privacy_request.submitted',
  'patient.created','lab_observation.reviewed','marker.view',
  'document.viewed','document.exported','report.exported','audit.exported',
  'membership.role_changed','membership.suspended'));

alter table clinical_audit.events drop constraint events_resource_type_check;
alter table clinical_audit.events add constraint events_resource_type_check
  check (resource_type in (
    'connection','consent','lab_import','clinical_record','privacy_request',
    'patient_profile','lab_observation','biomarker_observation','lab_document',
    'report','audit_log','organization_membership'));

create or replace function clinical_core.list_my_organizations()
returns table(organization_id uuid, name text, slug text, role text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform clinical_private.assert_production_context(
    clinical_private.organization_id(), 'clinical_data', 'workforce'
  );
  return query
  select organization.id, organization.organization_label,
    organization.id::text, membership.role
  from clinical_core.organization_memberships membership
  join clinical_core.organizations organization
    on organization.id = membership.organization_id
  where membership.person_id = clinical_private.actor_person_id()
    and membership.status = 'active'
    and organization.status = 'active'
  order by organization.organization_label, organization.id;
end
$$;

create or replace function clinical_core.list_org_members(_organization_id uuid)
returns table(
  membership_id uuid,
  user_id uuid,
  email text,
  display_name text,
  role text,
  status text,
  joined_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform clinical_private.assert_production_context(
    _organization_id, 'clinical_data', 'workforce'
  );
  if not exists (
    select 1 from clinical_core.organization_memberships caller
    where caller.organization_id = _organization_id
      and caller.person_id = clinical_private.actor_person_id()
      and caller.status = 'active'
      and caller.role in ('owner','admin')
  ) then
    raise exception using errcode = '42501', message = 'organization_admin_required';
  end if;

  return query
  select membership.id, membership.person_id, null::text, null::text,
    membership.role, membership.status, membership.created_at
  from clinical_core.organization_memberships membership
  where membership.organization_id = _organization_id
  order by membership.created_at, membership.id;
end
$$;

create or replace function clinical_core.set_org_member_role(
  _membership_id uuid,
  _role text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  _membership clinical_core.organization_memberships%rowtype;
  _caller_role text;
begin
  if _role not in ('owner','admin','practitioner','staff') then
    raise exception using errcode = '22023', message = 'membership_role_invalid';
  end if;
  perform clinical_private.assert_production_context(
    clinical_private.organization_id(), 'clinical_data', 'workforce'
  );
  select * into _membership
  from clinical_core.organization_memberships
  where id = _membership_id
    and organization_id = clinical_private.organization_id()
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'membership_not_found';
  end if;
  select caller.role into _caller_role
  from clinical_core.organization_memberships caller
  where caller.organization_id = _membership.organization_id
    and caller.person_id = clinical_private.actor_person_id()
    and caller.status = 'active'
    and caller.role in ('owner','admin');
  if _caller_role is null then
    raise exception using errcode = '42501', message = 'organization_admin_required';
  end if;
  if _membership.status <> 'active' then
    raise exception using errcode = '22023', message = 'membership_not_active';
  end if;
  if _role = _membership.role then return; end if;
  if (_role = 'owner' or _membership.role = 'owner') and _caller_role <> 'owner' then
    raise exception using errcode = '42501', message = 'owner_role_required';
  end if;
  if _membership.role = 'owner' and not exists (
    select 1 from clinical_core.organization_memberships other_owner
    where other_owner.organization_id = _membership.organization_id
      and other_owner.role = 'owner'
      and other_owner.status = 'active'
      and other_owner.id <> _membership.id
  ) then
    raise exception using errcode = '22023', message = 'last_owner_protected';
  end if;

  update clinical_core.organization_memberships
  set role = _role where id = _membership.id;
  insert into clinical_audit.events(
    organization_id, actor_person_id, action, resource_type, resource_id,
    purpose, safe_metadata
  ) values (
    _membership.organization_id, clinical_private.actor_person_id(),
    'membership.role_changed', 'organization_membership', _membership.id,
    'clinical_data', jsonb_build_object(
      'from', _membership.role, 'to', _role,
      'target_person_id', _membership.person_id::text)
  );
end
$$;

create or replace function clinical_core.remove_org_member(_membership_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  _membership clinical_core.organization_memberships%rowtype;
  _caller_role text;
begin
  perform clinical_private.assert_production_context(
    clinical_private.organization_id(), 'clinical_data', 'workforce'
  );
  select * into _membership
  from clinical_core.organization_memberships
  where id = _membership_id
    and organization_id = clinical_private.organization_id()
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'membership_not_found';
  end if;
  select caller.role into _caller_role
  from clinical_core.organization_memberships caller
  where caller.organization_id = _membership.organization_id
    and caller.person_id = clinical_private.actor_person_id()
    and caller.status = 'active'
    and caller.role in ('owner','admin');
  if _caller_role is null then
    raise exception using errcode = '42501', message = 'organization_admin_required';
  end if;
  if _membership.person_id = clinical_private.actor_person_id() then
    raise exception using errcode = '22023', message = 'self_suspension_refused';
  end if;
  if _membership.status = 'suspended' then return; end if;
  if _membership.role = 'owner' and _caller_role <> 'owner' then
    raise exception using errcode = '42501', message = 'owner_role_required';
  end if;
  if _membership.role = 'owner' and not exists (
    select 1 from clinical_core.organization_memberships other_owner
    where other_owner.organization_id = _membership.organization_id
      and other_owner.role = 'owner'
      and other_owner.status = 'active'
      and other_owner.id <> _membership.id
  ) then
    raise exception using errcode = '22023', message = 'last_owner_protected';
  end if;

  update clinical_core.organization_memberships
  set status = 'suspended' where id = _membership.id;
  insert into clinical_audit.events(
    organization_id, actor_person_id, action, resource_type, resource_id,
    purpose, safe_metadata
  ) values (
    _membership.organization_id, clinical_private.actor_person_id(),
    'membership.suspended', 'organization_membership', _membership.id,
    'clinical_data', jsonb_build_object(
      'role', _membership.role,
      'target_person_id', _membership.person_id::text)
  );
end
$$;

revoke all on function clinical_core.list_my_organizations() from public;
revoke all on function clinical_core.list_org_members(uuid) from public;
revoke all on function clinical_core.set_org_member_role(uuid, text) from public;
revoke all on function clinical_core.remove_org_member(uuid) from public;
grant execute on function clinical_core.list_my_organizations() to clinical_core_api;
grant execute on function clinical_core.list_org_members(uuid) to clinical_core_api;
grant execute on function clinical_core.set_org_member_role(uuid, text) to clinical_core_api;
grant execute on function clinical_core.remove_org_member(uuid) to clinical_core_api;
