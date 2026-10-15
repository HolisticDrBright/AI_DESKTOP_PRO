-- Unregistered source candidate (workforce-join-review-uniform-refusal). BLOCKED: applied nowhere, registered in no
-- manifest, and no route or role change depends on it. Registration and execution are Codex work after review.
--
-- Parent: workforce-clinic-approved-onboarding.sql (source candidate, SHA-256
-- 6ed75111bb58c11ad3741b2d96d200d4af7f018735224354454b23ddaacf3628), applied over the 106-migration production artifact.
-- It redefines one function, clinical_core.review_workforce_join_request, identical to the parent's except for the
-- lookup and refusal at its start. Signature, owner, security, search_path and grants are kept (create or replace keeps
-- the parent's EXECUTE grant to clinical_core_api only). No table, row, index, role or other function changes.
-- Rollback: workforce-join-review-uniform-refusal-rollback.sql restores the parent's definition exactly.
--
-- The defect. A clinic administrator reviews a join request by id. The parent looked the id up first and refused an
-- unknown one as not found, then checked authority over the request's clinic: an administrator of another clinic got
-- production_context_refused and a non-administrator of the same clinic got organization_admin_required. Three answers
-- (and two HTTP statuses through the compatibility adapter: 404 and 403) for one question, so the refusal itself told a
-- caller in one clinic whether a request existed in another. The successor answers all three the same way. An
-- administrator of the request's clinic is unaffected; approval, rejection, replay, self-approval, the already-member
-- and suspended-owner rules are the parent's.

create or replace function clinical_core.review_workforce_join_request(_request_id uuid,_approve boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _request clinical_private.workforce_access_requests%rowtype;
  _person uuid; _membership uuid; _actor uuid;
begin
  if _request_id is null or _approve is null then
    raise exception using errcode='22023',message='workforce_review_invalid';
  end if;
  -- One refusal for every caller who may not review this request. An unknown id, a request for another clinic
  -- (the caller's request context names a different one) and a caller who is not a current owner or admin of the
  -- request's clinic all answer workforce_application_not_found, with the same SQLSTATE, before anything about the
  -- request, its clinic or its applicant is read back or locked. The parent answered these three ways
  -- (P0002 workforce_application_not_found, 42501 production_context_refused, 42501 organization_admin_required),
  -- so any clinic's admin could tell whether a request id existed elsewhere.
  select * into _request from clinical_private.workforce_access_requests
    where id=_request_id and kind='join' and requested_organization_id=clinical_private.organization_id();
  if not found or not exists (select 1 from clinical_core.organization_memberships m
      where m.organization_id=_request.requested_organization_id
        and m.person_id=clinical_private.actor_person_id()
        and m.status='active' and m.role in ('owner','admin')) then
    raise exception using errcode='P0002',message='workforce_application_not_found';
  end if;
  -- The full current-authority check is unchanged and still runs: production context, purpose and pool.
  perform clinical_private.require_organization_admin(_request.requested_organization_id,false);
  _actor:=clinical_private.actor_person_id();
  perform pg_advisory_xact_lock(hashtextextended(_request.identity_subject,0));
  select * into _request from clinical_private.workforce_access_requests
    where id=_request_id and kind='join' for update;
  if _request.status<>'pending' then
    if (_request.status='approved') is distinct from _approve then
      raise exception using errcode='22023',message='workforce_review_conflict';
    end if;
    return jsonb_build_object('status',_request.status,
      'organizationId',_request.approved_organization_id,
      'membershipId',_request.approved_membership_id);
  end if;
  if _approve then
    if not exists (select 1 from clinical_core.organizations
      where id=_request.requested_organization_id and status='active') then
      raise exception using errcode='42501',message='workforce_clinic_unavailable';
    end if;
    _person:=clinical_private.bind_approved_workforce_subject(
      _request.identity_subject,_request.email_sha256);
    if _person=_actor then
      raise exception using errcode='42501',message='workforce_self_approval_refused';
    end if;
    if exists (select 1 from clinical_core.organization_memberships
      where organization_id=_request.requested_organization_id
        and person_id=_person and status='active') then
      raise exception using errcode='22023',message='workforce_already_member';
    end if;
    -- A previously suspended owner/admin must never recover that elevated
    -- role through an ordinary practitioner application.
    insert into clinical_core.organization_memberships(organization_id,person_id,role,status)
      values (_request.requested_organization_id,_person,'practitioner','active')
      on conflict (organization_id,person_id) do update
        set status='active',role='practitioner'
      returning id into _membership;
  end if;
  update clinical_private.workforce_access_requests set
    status=case when _approve then 'approved' else 'rejected' end,
    approved_organization_id=case when _approve then _request.requested_organization_id else null end,
    approved_membership_id=_membership,
    reviewer_person_id=_actor,decided_at=clock_timestamp()
    where id=_request_id;
  insert into clinical_private.workforce_access_events(request_id,action,reviewer_person_id)
    values (_request_id,case when _approve then 'approved' else 'rejected' end,_actor);
  return jsonb_build_object('status',case when _approve then 'approved' else 'rejected' end,
    'organizationId',case when _approve then _request.requested_organization_id else null end,
    'membershipId',_membership);
end $$;

