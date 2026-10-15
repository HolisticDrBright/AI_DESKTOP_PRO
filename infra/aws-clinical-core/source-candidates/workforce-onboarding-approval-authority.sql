-- UNREGISTERED, BLOCKED source candidate (workforce-onboarding-approval-authority). Applied nowhere, registered in no
-- manifest; no route, role or Lambda depends on it. Registration and execution are Codex work after review.
--
-- Parents, applied in this order over the 106-migration production artifact (the order the uniform-refusal tests use):
--   source-candidates/workforce-token-binding-lookup.sql
--   source-candidates/workforce-clinic-approved-onboarding.sql      (SHA-256 6ed75111bb58c11ad3741b2d96d200d4af7f018735224354454b23ddaacf3628)
--   production-candidates/workforce-invitation-role-repair.sql      (independent of the others; kept so a re-invitation
--                                                                    cannot change a role this candidate decided)
--   source-candidates/workforce-join-review-uniform-refusal.sql     (SHA-256 7086b1a90db8cac47120a9d2be54f91f966b24e264351d3a247be838c872ee29)
-- The clinic-admin functions are called after source-candidates/workforce-current-membership-context.sql has set the
-- request context from current rows; nothing here depends on that setter's text, only on the context it sets.
-- Rollback: workforce-onboarding-approval-authority-rollback.sql restores the parents exactly.
--
-- Preserving. It adds two nullable reason columns, three tables and four functions; it redefines the applicant status
-- read and activate_my_memberships with their parents' behaviour plus the rules below; it withdraws EXECUTE on the two
-- parent review functions so the reasoned ones are the only doors. No existing row is changed.
--
-- What the parents could not enforce in the deciding transaction, and this does:
-- 1. Every decision carries a reason from a closed vocabulary, stored on the request and in its append-only event. No
--    free text: a narrative is where an email address or a health detail ends up.
-- 2. A clinic administrator approves only an applicant they can name: the approval carries the SHA-256 of the
--    applicant's email as the administrator knows it, and must equal the digest the applicant's verified account gave.
--    The database never stores, and the administrator's list never shows, the email itself.
-- 3. The administrator's own active owner/admin membership in the selected clinic, and the clinic itself, are locked
--    FOR SHARE for the rest of the deciding transaction, so a demotion, removal or suspension that races the decision
--    either waits for it or is seen by it; it cannot land between the check and the write.
-- 4. A platform operator is a registered, active operator subject (a table nothing can write except its owner), and is
--    never the applicant: not the applicant's subject, nor a workforce account holding the applicant's verified email.
-- 5. An approved clinic proposal grants nothing clinical: the new clinic's owner membership is created `pending` under
--    an activation hold that activate_my_memberships respects, so neither the current-membership setter, nor
--    has_clinical_role, nor self-activation can turn it on. Releasing a hold is not defined here: it needs the owner's
--    decision on what activates a new clinic (agreements, verification, who records it).
-- 6. A revocation carries a reason too. revoke_workforce_membership is remove_org_member (its authority, lock, owner
--    and self rules and its audit event, unchanged) plus a reason in an append-only ledger. remove_org_member itself
--    stays granted: the Desktop team screen calls it, and withdrawing it is the owner's decision, not this candidate's.

alter table clinical_private.workforce_access_requests add column decision_reason text
  check (decision_reason is null or decision_reason in ('identity_confirmed_by_clinic','clinic_proposal_verified',
    'not_known_to_clinic','credentials_not_verified','clinic_not_accepting','duplicate_request',
    'clinic_proposal_incomplete','clinic_proposal_declined'));
alter table clinical_private.workforce_access_events add column reason_code text
  check (reason_code is null or reason_code in ('identity_confirmed_by_clinic','clinic_proposal_verified',
    'not_known_to_clinic','credentials_not_verified','clinic_not_accepting','duplicate_request',
    'clinic_proposal_incomplete','clinic_proposal_declined'));

-- Platform operators: written only by the table owner, outside every API role.
create table clinical_private.workforce_platform_operators (
  operator_subject text primary key check (operator_subject ~
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'),
  status text not null default 'active' check (status in ('active','disabled')),
  granted_at timestamptz not null default clock_timestamp()
);
alter table clinical_private.workforce_platform_operators enable row level security;
revoke all on clinical_private.workforce_platform_operators
  from public,clinical_core_api,clinical_workforce_application,clinical_workforce_operator;

-- An approved clinic proposal's owner membership, held until the clinic is activated by a decision defined elsewhere.
create table clinical_private.workforce_clinic_activation_holds (
  organization_id uuid primary key references clinical_core.organizations(id),
  membership_id uuid not null unique references clinical_core.organization_memberships(id),
  request_id uuid not null unique references clinical_private.workforce_access_requests(id),
  created_at timestamptz not null default clock_timestamp()
);
alter table clinical_private.workforce_clinic_activation_holds enable row level security;
revoke all on clinical_private.workforce_clinic_activation_holds
  from public,clinical_core_api,clinical_workforce_application,clinical_workforce_operator;

-- Reasoned revocations, append-only, written only by revoke_workforce_membership.
create table clinical_private.workforce_membership_revocations (
  id uuid primary key default gen_random_uuid(),
  membership_id uuid not null references clinical_core.organization_memberships(id),
  organization_id uuid not null references clinical_core.organizations(id),
  reviewer_person_id uuid not null references clinical_core.persons(id),
  reason_code text not null check (reason_code in ('left_clinic','credentials_lapsed','access_no_longer_needed',
    'security_concern')),
  occurred_at timestamptz not null default clock_timestamp()
);
create index workforce_membership_revocations_membership
  on clinical_private.workforce_membership_revocations(membership_id,occurred_at,id);
create index workforce_membership_revocations_org_fk
  on clinical_private.workforce_membership_revocations(organization_id);
create index workforce_membership_revocations_reviewer_fk
  on clinical_private.workforce_membership_revocations(reviewer_person_id);
alter table clinical_private.workforce_membership_revocations enable row level security;
create trigger workforce_membership_revocations_append_only before update or delete
  on clinical_private.workforce_membership_revocations for each row
  execute function clinical_private.block_update_delete();
revoke all on clinical_private.workforce_membership_revocations
  from public,clinical_core_api,clinical_workforce_application,clinical_workforce_operator;

-- The parent's self-activation, unchanged except that a held membership is never activated by its own holder.
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
    and membership.status = 'pending'
    and not exists (select 1 from clinical_private.workforce_clinic_activation_holds hold
      where hold.membership_id = membership.id);
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

-- The applicant's own requests, as before, plus the decision reason and, for an approved request, whether clinical
-- access exists now. Nothing about the clinic's staff, patients or other applicants.
create or replace function clinical_private.workforce_access_status_for_subject(_subject text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if _subject is null or _subject !~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' then
    raise exception using errcode='22023',message='workforce_subject_invalid';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id',r.id,'kind',r.kind,'status',r.status,'createdAt',r.created_at,
      'organizationId',coalesce(r.approved_organization_id,r.requested_organization_id),
      'decisionReason',r.decision_reason,
      'clinicalAccess',case when r.status<>'approved' then null
        when exists (select 1 from clinical_private.workforce_clinic_activation_holds h
          where h.membership_id=r.approved_membership_id) then 'held_for_clinic_activation'
        -- 'available' is exactly what set_current_workforce_context would admit for this membership now.
        when exists (select 1 from clinical_core.organization_memberships m
          join clinical_core.organizations o on o.id=m.organization_id
          join clinical_core.identities i on i.person_id=m.person_id
            and i.identity_pool='workforce' and i.identity_subject=r.identity_subject
          join clinical_core.persons p on p.id=m.person_id
          where m.id=r.approved_membership_id and m.status='active'
            and m.role in ('owner','admin','practitioner','staff')
            and o.status='active' and o.environment='production-clinical' and o.data_classification='clinical_phi'
            and o.contains_phi is true and i.status='active' and i.production_bound is true
            and p.status='active' and p.contains_phi is true) then 'available'
        else 'not_available' end)
      order by r.created_at desc,r.id)
    from (select * from clinical_private.workforce_access_requests
      where identity_subject=_subject order by created_at desc,id limit 50) r),'[]'::jsonb);
end $$;

-- The selected clinic's join requests, for its current owner or admin: what to decide, never who the applicant is.
create function clinical_core.list_workforce_join_requests()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  perform clinical_private.require_organization_admin(clinical_private.organization_id(),false);
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id',r.id,'status',r.status,'createdAt',r.created_at,'decidedAt',r.decided_at,
      'decisionReason',r.decision_reason) order by r.created_at desc,r.id)
    from (select * from clinical_private.workforce_access_requests
      where kind='join' and requested_organization_id=clinical_private.organization_id()
      order by created_at desc,id limit 50) r),'[]'::jsonb);
end $$;

create function clinical_core.review_workforce_join_request_v2(
  _request_id uuid,_approve boolean,_reason text,_applicant_email_sha256 text default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare _request clinical_private.workforce_access_requests%rowtype;
  _person uuid; _membership uuid; _actor uuid;
begin
  if _request_id is null or _approve is null or _reason is null
    or (_approve and (_reason<>'identity_confirmed_by_clinic'
      or _applicant_email_sha256 is null or _applicant_email_sha256 !~ '^[0-9a-f]{64}$'))
    or (not _approve and (_reason not in ('not_known_to_clinic','credentials_not_verified','clinic_not_accepting',
      'duplicate_request') or _applicant_email_sha256 is not null)) then
    raise exception using errcode='22023',message='workforce_review_invalid';
  end if;
  -- One refusal for an unknown id, another clinic's request and a caller who is not its current owner or admin (the
  -- uniform-refusal successor's rule), now with the caller's membership and the clinic locked for this transaction.
  select * into _request from clinical_private.workforce_access_requests
    where id=_request_id and kind='join' and requested_organization_id=clinical_private.organization_id();
  if not found or not exists (select 1 from clinical_core.organization_memberships m
      where m.organization_id=_request.requested_organization_id
        and m.person_id=clinical_private.actor_person_id()
        and m.status='active' and m.role in ('owner','admin') for share)
    or not exists (select 1 from clinical_core.organizations o
      where o.id=_request.requested_organization_id for share) then
    raise exception using errcode='P0002',message='workforce_application_not_found';
  end if;
  perform clinical_private.require_organization_admin(_request.requested_organization_id,false);
  _actor:=clinical_private.actor_person_id();
  perform pg_advisory_xact_lock(hashtextextended(_request.identity_subject,0));
  select * into _request from clinical_private.workforce_access_requests
    where id=_request_id and kind='join' for update;
  if _request.status<>'pending' then
    -- A retried decision is the stored decision; a different one is a conflict. Neither changes anything, so a replay
    -- after a removal never restores the membership.
    if (_request.status='approved') is distinct from _approve then
      raise exception using errcode='22023',message='workforce_review_conflict';
    end if;
    return jsonb_build_object('status',_request.status,'organizationId',_request.approved_organization_id,
      'membershipId',_request.approved_membership_id,'decisionReason',_request.decision_reason,'duplicate',true);
  end if;
  if _approve then
    if _request.email_sha256 is distinct from _applicant_email_sha256 then
      raise exception using errcode='42501',message='workforce_review_applicant_mismatch';
    end if;
    if not exists (select 1 from clinical_core.organizations
      where id=_request.requested_organization_id and status='active') then
      raise exception using errcode='42501',message='workforce_clinic_unavailable';
    end if;
    _person:=clinical_private.bind_approved_workforce_subject(_request.identity_subject,_request.email_sha256);
    if _person=_actor then
      raise exception using errcode='42501',message='workforce_self_approval_refused';
    end if;
    if exists (select 1 from clinical_core.organization_memberships
      where organization_id=_request.requested_organization_id and person_id=_person and status='active') then
      raise exception using errcode='22023',message='workforce_already_member';
    end if;
    -- A previously suspended owner/admin never recovers that role through an ordinary application.
    insert into clinical_core.organization_memberships(organization_id,person_id,role,status)
      values (_request.requested_organization_id,_person,'practitioner','active')
      on conflict (organization_id,person_id) do update set status='active',role='practitioner'
      returning id into _membership;
  end if;
  update clinical_private.workforce_access_requests set
    status=case when _approve then 'approved' else 'rejected' end,
    approved_organization_id=case when _approve then _request.requested_organization_id else null end,
    approved_membership_id=_membership,reviewer_person_id=_actor,decision_reason=_reason,decided_at=clock_timestamp()
    where id=_request_id;
  insert into clinical_private.workforce_access_events(request_id,action,reviewer_person_id,reason_code)
    values (_request_id,case when _approve then 'approved' else 'rejected' end,_actor,_reason);
  return jsonb_build_object('status',case when _approve then 'approved' else 'rejected' end,
    'organizationId',case when _approve then _request.requested_organization_id else null end,
    'membershipId',_membership,'decisionReason',_reason,'duplicate',false);
end $$;

create function clinical_private.review_workforce_clinic_proposal_v2(
  _request_id uuid,_approve boolean,_operator_subject text,_reason text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare _request clinical_private.workforce_access_requests%rowtype;
  _person uuid; _organization uuid; _membership uuid;
begin
  if _request_id is null or _approve is null or _operator_subject is null or _reason is null
    or (_approve and _reason<>'clinic_proposal_verified')
    or (not _approve and _reason not in ('clinic_proposal_incomplete','clinic_proposal_declined','duplicate_request')) then
    raise exception using errcode='22023',message='workforce_review_invalid';
  end if;
  if not exists (select 1 from clinical_private.workforce_platform_operators
      where operator_subject=_operator_subject and status='active' for share) then
    raise exception using errcode='42501',message='workforce_operator_refused';
  end if;
  select * into _request from clinical_private.workforce_access_requests
    where id=_request_id and kind='create_clinic';
  if not found then raise exception using errcode='P0002',message='workforce_application_not_found'; end if;
  -- Never the applicant: not the same subject, and not a second workforce account holding the applicant's verified
  -- email (a person has one workforce identity, so the address is what a second account would share).
  if lower(_operator_subject)=lower(_request.identity_subject) or exists (
      select 1 from clinical_core.workforce_identity_directory d
      where lower(d.identity_subject)=lower(_operator_subject) and d.email_sha256=_request.email_sha256) then
    raise exception using errcode='42501',message='workforce_self_approval_refused';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(_request.identity_subject,0));
  select * into _request from clinical_private.workforce_access_requests
    where id=_request_id and kind='create_clinic' for update;
  if _request.status<>'pending' then
    if (_request.status='approved') is distinct from _approve then
      raise exception using errcode='22023',message='workforce_review_conflict';
    end if;
    return jsonb_build_object('status',_request.status,'organizationId',_request.approved_organization_id,
      'membershipId',_request.approved_membership_id,'decisionReason',_request.decision_reason,
      'activation',case when _request.status='approved' then 'held' else null end,'duplicate',true);
  end if;
  if _approve then
    _person:=clinical_private.bind_approved_workforce_subject(_request.identity_subject,_request.email_sha256);
    insert into clinical_core.organizations(organization_label)
      values (_request.proposed_organization_label) returning id into _organization;
    -- The owner membership exists so the decision is recorded, and grants nothing until the clinic is activated.
    insert into clinical_core.organization_memberships(organization_id,person_id,role,status)
      values (_organization,_person,'owner','pending') returning id into _membership;
    insert into clinical_private.workforce_clinic_activation_holds(organization_id,membership_id,request_id)
      values (_organization,_membership,_request_id);
  end if;
  update clinical_private.workforce_access_requests set
    status=case when _approve then 'approved' else 'rejected' end,
    approved_organization_id=_organization,approved_membership_id=_membership,
    operator_subject=_operator_subject,decision_reason=_reason,decided_at=clock_timestamp()
    where id=_request_id;
  insert into clinical_private.workforce_access_events(request_id,action,operator_subject,reason_code)
    values (_request_id,case when _approve then 'approved' else 'rejected' end,_operator_subject,_reason);
  return jsonb_build_object('status',case when _approve then 'approved' else 'rejected' end,
    'organizationId',_organization,'membershipId',_membership,'decisionReason',_reason,
    'activation',case when _approve then 'held' else null end,'duplicate',false);
end $$;

-- remove_org_member, with a reason recorded. A second revocation of a suspended membership changes nothing and records
-- nothing; it answers duplicate.
create function clinical_core.revoke_workforce_membership(_membership_id uuid,_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _membership clinical_core.organization_memberships%rowtype;
begin
  if _membership_id is null or _reason is null or _reason not in ('left_clinic','credentials_lapsed',
      'access_no_longer_needed','security_concern') then
    raise exception using errcode='22023',message='workforce_revocation_invalid';
  end if;
  -- The same row lock remove_org_member takes, taken first so the status read here is the one it acts on.
  select * into _membership from clinical_core.organization_memberships
    where id=_membership_id and organization_id=clinical_private.organization_id() for update;
  perform clinical_core.remove_org_member(_membership_id);
  if _membership.status<>'suspended' then
    insert into clinical_private.workforce_membership_revocations(membership_id,organization_id,reviewer_person_id,reason_code)
      values (_membership.id,_membership.organization_id,clinical_private.actor_person_id(),_reason);
  end if;
  return jsonb_build_object('membershipId',_membership.id,'status','suspended','reason',_reason,
    'duplicate',_membership.status='suspended');
end $$;

-- The reasoned functions are the only doors.
revoke execute on function clinical_core.review_workforce_join_request(uuid,boolean) from clinical_core_api;
revoke execute on function clinical_private.review_workforce_clinic_proposal(uuid,boolean,text) from clinical_workforce_operator;
revoke all on function clinical_core.list_workforce_join_requests() from public,clinical_workforce_application,clinical_workforce_operator;
revoke all on function clinical_core.review_workforce_join_request_v2(uuid,boolean,text,text)
  from public,clinical_workforce_application,clinical_workforce_operator;
revoke all on function clinical_private.review_workforce_clinic_proposal_v2(uuid,boolean,text,text)
  from public,clinical_core_api,clinical_workforce_application;
revoke all on function clinical_core.revoke_workforce_membership(uuid,text)
  from public,clinical_workforce_application,clinical_workforce_operator;
grant execute on function clinical_core.list_workforce_join_requests() to clinical_core_api;
grant execute on function clinical_core.revoke_workforce_membership(uuid,text) to clinical_core_api;
grant execute on function clinical_core.review_workforce_join_request_v2(uuid,boolean,text,text) to clinical_core_api;
grant execute on function clinical_private.review_workforce_clinic_proposal_v2(uuid,boolean,text,text) to clinical_workforce_operator;
