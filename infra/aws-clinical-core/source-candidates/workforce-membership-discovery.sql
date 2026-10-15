-- UNREGISTERED, BLOCKED successor. No live API calls this function, and no database has it.
--
-- Subject-only discovery of the signed-in workforce subject's clinics, so a practitioner can choose a FIRST clinic under
-- the `database_current` authority before any clinic is selected. The caller must validate the Cognito ID token
-- (account, issuer, audience, token use, UUID subject, verified email, live expiry) before supplying its subject.
--
-- It sets no request context, reads no patient, record or clinical row, and grants nothing: every later clinical
-- request still runs clinical_private.set_current_workforce_context for exactly one selected clinic, under current
-- rows and locks. `clinics` is only active memberships with a clinical role in an active production clinic; `pending`
-- names clinics where approval is still awaited and carries no role, because it is not access. A suspended membership,
-- the non-clinical `member` role and inactive clinics appear in neither list.
--
-- An unknown, inactive, non-production or ambiguous identity is refused rather than answered as "no clinics".

create function clinical_private.discover_current_workforce_memberships(_subject text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare _identities integer;
  _identity clinical_core.identities%rowtype;
  _person clinical_core.persons%rowtype;
begin
  if _subject is null or _subject !~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' then
    raise exception using errcode='42501',message='workforce_membership_refused';
  end if;
  select count(*) into _identities from clinical_core.identities
    where identity_pool='workforce' and identity_subject=_subject;
  if _identities<>1 then
    raise exception using errcode='42501',message='workforce_membership_refused';
  end if;
  select * into _identity from clinical_core.identities
    where identity_pool='workforce' and identity_subject=_subject;
  if _identity.status<>'active' or _identity.production_bound is distinct from true then
    raise exception using errcode='42501',message='workforce_membership_refused';
  end if;
  select * into _person from clinical_core.persons where id=_identity.person_id;
  if not found or _person.status<>'active' or _person.contains_phi is distinct from true then
    raise exception using errcode='42501',message='workforce_membership_refused';
  end if;

  return jsonb_build_object(
    'clinics',coalesce((select jsonb_agg(jsonb_build_object(
        'organizationId',organization.id,'name',organization.organization_label,'role',membership.role)
        order by organization.organization_label,organization.id)
      from clinical_core.organization_memberships membership
      join clinical_core.organizations organization on organization.id=membership.organization_id
      where membership.person_id=_person.id and membership.status='active'
        and membership.role in ('owner','admin','practitioner','staff')
        and organization.status='active' and organization.environment='production-clinical'
        and organization.data_classification='clinical_phi' and organization.contains_phi is true),'[]'::jsonb),
    'pending',coalesce((select jsonb_agg(jsonb_build_object(
        'organizationId',organization.id,'name',organization.organization_label)
        order by organization.organization_label,organization.id)
      from clinical_core.organization_memberships membership
      join clinical_core.organizations organization on organization.id=membership.organization_id
      where membership.person_id=_person.id and membership.status='pending'
        and organization.status='active' and organization.environment='production-clinical'
        and organization.data_classification='clinical_phi' and organization.contains_phi is true),'[]'::jsonb));
end $$;

revoke all on function clinical_private.discover_current_workforce_memberships(text) from public;
grant execute on function clinical_private.discover_current_workforce_memberships(text) to clinical_core_api;
