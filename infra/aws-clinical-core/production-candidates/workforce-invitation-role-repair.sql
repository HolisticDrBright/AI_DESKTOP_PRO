-- Unreleased production candidate: the workforce invitation path never changes an existing membership
-- (workforce-invitation-role-repair). BLOCKED: applied nowhere and registered in no manifest.
--
-- Parent: the 106-migration production artifact. It redefines one function, clinical_core.add_org_member, exactly as
-- 20260826161000_production_workforce_email_digest_repair.sql last defined it except for the conflict clause. No other
-- object, grant, ledger, IAM, Cognito or custody file changes. Registration and execution are Codex work after review.
-- Rollback: workforce-invitation-role-repair-rollback.sql.
--
-- The defect. The invitation upserted on (organization, person) and overwrote the role: an admin who re-invited an
-- existing owner as `member` demoted them, past set_org_member_role's owner guards (only a NEW owner invitation is
-- checked), and any active member's role could be changed by an invitation with no audit of the change as a role
-- change. An invitation now creates a pending membership or refuses with membership_exists; a role change goes through
-- set_org_member_role, unchanged, and a suspended member is not reinstated by being invited again.
--
-- Independent of the clinic-approved onboarding candidates on agent/workforce-clinic-approved-membership-20261015
-- (workforce-clinic-approved-onboarding.sql and workforce-current-membership-context.sql), which do not touch this
-- function; it can be applied before, after or without them.

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

  -- An existing membership (pending, active or suspended) is not an invitation's to change. A role change is
  -- set_org_member_role's, with its own owner guards; a suspended member is not reinstated by being invited again.
  insert into clinical_core.organization_memberships(
    organization_id, person_id, role, status
  ) values (_organization_id, _person_id, _role, 'pending')
  on conflict (organization_id,person_id) do nothing
  returning id into _membership_id;
  if _membership_id is null then
    raise exception using errcode = '40001', message = 'membership_exists';
  end if;

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
