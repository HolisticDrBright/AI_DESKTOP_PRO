-- AWS-native workforce invitation claims.
--
-- Desktop may look up an already-provisioned Cognito workforce identity by
-- email, but it cannot create identities, passwords, or email aliases. Only a
-- one-way email digest is stored here. The identity-admin process owns the
-- directory population step.

alter table clinical_core.organization_memberships
  drop constraint organization_memberships_role_check;
alter table clinical_core.organization_memberships
  add constraint organization_memberships_role_check
  check (role in ('owner','admin','practitioner','staff','member'));

alter table clinical_core.organization_memberships
  drop constraint organization_memberships_status_check;
alter table clinical_core.organization_memberships
  add constraint organization_memberships_status_check
  check (status in ('pending','active','suspended'));

create table clinical_core.workforce_identity_directory (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references clinical_core.persons(id),
  identity_subject text not null
    check (identity_subject ~ '^[A-Za-z0-9:_-]{8,128}$'),
  email_sha256 text not null check (email_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'active' check (status in ('active','disabled')),
  registered_at timestamptz not null default clock_timestamp(),
  unique (identity_subject),
  unique (email_sha256),
  unique (person_id)
);

create index workforce_identity_directory_person_idx
  on clinical_core.workforce_identity_directory(person_id);

alter table clinical_core.workforce_identity_directory enable row level security;
revoke all on clinical_core.workforce_identity_directory from public;
revoke all on clinical_core.workforce_identity_directory from clinical_core_api;

create or replace function clinical_private.require_organization_admin(
  _organization_id uuid,
  _owner_only boolean default false
) returns text
language plpgsql stable security definer set search_path = '' as $$
declare _role text;
begin
  perform clinical_private.assert_production_context(
    _organization_id, 'clinical_data', 'workforce'
  );
  select membership.role into _role
  from clinical_core.organization_memberships membership
  where membership.organization_id = _organization_id
    and membership.person_id = clinical_private.actor_person_id()
    and membership.status = 'active'
    and membership.role in ('owner','admin');
  if _role is null or (_owner_only and _role <> 'owner') then
    raise exception using errcode = '42501', message = 'organization_admin_required';
  end if;
  return _role;
end
$$;

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
  where directory.email_sha256 = encode(digest(_normalized_email,'sha256'),'hex')
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

create or replace function clinical_core.activate_my_memberships()
returns integer
language plpgsql security definer set search_path = '' as $$
declare _activated integer;
begin
  perform clinical_private.assert_production_context(
    clinical_private.organization_id(), 'clinical_data', 'workforce'
  );
  update clinical_core.organization_memberships membership
  set status = 'active'
  where membership.organization_id = clinical_private.organization_id()
    and membership.person_id = clinical_private.actor_person_id()
    and membership.status = 'pending';
  get diagnostics _activated = row_count;
  if _activated > 0 then
    insert into clinical_audit.events(
      organization_id, actor_person_id, action, resource_type, purpose,
      safe_metadata
    ) values (
      clinical_private.organization_id(), clinical_private.actor_person_id(),
      'membership.role_changed', 'organization_membership', 'clinical_data',
      jsonb_build_object('event','activated','count',_activated)
    );
  end if;
  return _activated;
end
$$;

create or replace function clinical_core.set_org_member_role(
  _membership_id uuid,
  _role text
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  _membership clinical_core.organization_memberships%rowtype;
  _caller_role text;
begin
  if _role not in ('owner','admin','practitioner','staff','member') then
    raise exception using errcode = '22023', message = 'membership_role_invalid';
  end if;
  perform clinical_private.assert_production_context(
    clinical_private.organization_id(), 'clinical_data', 'workforce'
  );
  select * into _membership from clinical_core.organization_memberships
  where id=_membership_id and organization_id=clinical_private.organization_id()
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'membership_not_found';
  end if;
  select role into _caller_role from clinical_core.organization_memberships
  where organization_id=_membership.organization_id
    and person_id=clinical_private.actor_person_id()
    and status='active' and role in ('owner','admin');
  if _caller_role is null then
    raise exception using errcode = '42501', message = 'organization_admin_required';
  end if;
  if _membership.status <> 'active' then
    raise exception using errcode = '22023', message = 'membership_not_active';
  end if;
  if (_role='owner' or _membership.role='owner') and _caller_role <> 'owner' then
    raise exception using errcode = '42501', message = 'owner_role_required';
  end if;
  if _membership.role='owner' and _role<>'owner' and not exists (
    select 1 from clinical_core.organization_memberships other_owner
    where other_owner.organization_id=_membership.organization_id
      and other_owner.role='owner' and other_owner.status='active'
      and other_owner.id<>_membership.id
  ) then
    raise exception using errcode = '22023', message = 'last_owner_protected';
  end if;
  if _role=_membership.role then return; end if;
  update clinical_core.organization_memberships set role=_role where id=_membership.id;
  insert into clinical_audit.events(
    organization_id,actor_person_id,action,resource_type,resource_id,purpose,safe_metadata
  ) values (
    _membership.organization_id,clinical_private.actor_person_id(),
    'membership.role_changed','organization_membership',_membership.id,
    'clinical_data',jsonb_build_object('from',_membership.role,'to',_role)
  );
end
$$;

revoke all on function clinical_private.require_organization_admin(uuid,boolean) from public;
revoke all on function clinical_core.add_org_member(uuid,text,text) from public;
revoke all on function clinical_core.activate_my_memberships() from public;
revoke all on function clinical_core.set_org_member_role(uuid,text) from public;
grant execute on function clinical_core.add_org_member(uuid,text,text) to clinical_core_api;
grant execute on function clinical_core.activate_my_memberships() to clinical_core_api;
grant execute on function clinical_core.set_org_member_role(uuid,text) to clinical_core_api;
