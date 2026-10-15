-- Rollback for workforce-join-review-uniform-refusal.sql (BLOCKED; applied nowhere). Restores the parent's definition of
-- clinical_core.review_workforce_join_request exactly as workforce-clinic-approved-onboarding.sql (SHA-256
-- 6ed75111bb58c11ad3741b2d96d200d4af7f018735224354454b23ddaacf3628) creates it. create or replace keeps the grants.
-- No request, decision, membership or audit row is touched: the successor wrote none.

create or replace function clinical_core.review_workforce_join_request(_request_id uuid,_approve boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _request clinical_private.workforce_access_requests%rowtype;
  _person uuid; _membership uuid; _actor uuid;
begin
  if _request_id is null or _approve is null then
    raise exception using errcode='22023',message='workforce_review_invalid';
  end if;
  -- Look up the target without returning it, then require current authority
  -- before exposing status or taking the subject lock.
  select * into _request from clinical_private.workforce_access_requests
    where id=_request_id and kind='join';
  if not found then raise exception using errcode='P0002',message='workforce_application_not_found'; end if;
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

