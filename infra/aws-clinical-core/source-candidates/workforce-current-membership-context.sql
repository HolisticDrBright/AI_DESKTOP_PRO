-- UNREGISTERED successor. No live API calls this function.
-- The caller must validate the Cognito ID token's issuer, audience, subject,
-- account and session before supplying its subject and selected clinic.
-- This function resolves authority from current rows, never token clinic claims.

create function clinical_private.set_current_workforce_context(
  _subject text,_selected_organization_id uuid,_purpose text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare _identity clinical_core.identities%rowtype;
  _person clinical_core.persons%rowtype;
  _organization clinical_core.organizations%rowtype;
  _membership clinical_core.organization_memberships%rowtype;
begin
  if _subject is null or _subject !~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
    or _selected_organization_id is null
    or _purpose is null
    or _purpose not in ('clinical_data','identity_link','consent_management') then
    raise exception using errcode='42501',message='workforce_membership_refused';
  end if;

  -- A consistent lock order keeps the identity, person, clinic and membership
  -- current for the enclosing clinical transaction. Revocation must wait for
  -- an admitted request to finish; a request after revocation must refuse.
  select * into _identity from clinical_core.identities
    where identity_pool='workforce' and identity_subject=_subject for share;
  if not found or _identity.status<>'active' or _identity.production_bound is distinct from true then
    raise exception using errcode='42501',message='workforce_membership_refused';
  end if;
  select * into _person from clinical_core.persons
    where id=_identity.person_id for share;
  if not found or _person.status<>'active' or _person.contains_phi is distinct from true then
    raise exception using errcode='42501',message='workforce_membership_refused';
  end if;
  select * into _organization from clinical_core.organizations
    where id=_selected_organization_id for share;
  if not found or _organization.status<>'active'
    or _organization.environment<>'production-clinical'
    or _organization.data_classification<>'clinical_phi'
    or _organization.contains_phi is distinct from true then
    raise exception using errcode='42501',message='workforce_membership_refused';
  end if;
  select * into _membership from clinical_core.organization_memberships
    where organization_id=_selected_organization_id and person_id=_person.id for share;
  if not found or _membership.status<>'active'
    or _membership.role not in ('owner','admin','practitioner','staff') then
    raise exception using errcode='42501',message='workforce_membership_refused';
  end if;

  perform set_config('clinical.claim.actor_person_id',_person.id::text,true);
  perform set_config('clinical.claim.organization_id',_organization.id::text,true);
  perform set_config('clinical.claim.identity_pool','workforce',true);
  perform set_config('clinical.claim.identity_subject',_subject,true);
  perform set_config('clinical.claim.purpose',_purpose,true);
  perform set_config('clinical.claim.environment','production-clinical',true);
  perform set_config('clinical.claim.data_classification','clinical_phi',true);
  return jsonb_build_object('personId',_person.id,'organizationId',_organization.id,
    'role',_membership.role);
end $$;

revoke all on function clinical_private.set_current_workforce_context(text,uuid,text)
  from public;
grant execute on function clinical_private.set_current_workforce_context(text,uuid,text)
  to clinical_core_api;
