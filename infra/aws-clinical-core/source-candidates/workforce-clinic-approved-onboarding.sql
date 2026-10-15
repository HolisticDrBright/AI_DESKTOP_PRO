-- UNREGISTERED, BLOCKED source candidate. No live database or Cognito pool uses it.
-- The application service must verify the Cognito subject and current verified
-- email independently; applicant-supplied claims are never passed to these RPCs.

do $$
begin
  if not exists (select 1 from pg_roles where rolname='clinical_workforce_application') then
    create role clinical_workforce_application nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname='clinical_workforce_operator') then
    create role clinical_workforce_operator nologin noinherit;
  end if;
end $$;
grant usage on schema clinical_private to clinical_workforce_application, clinical_workforce_operator;

create table clinical_private.workforce_access_requests (
  id uuid primary key,
  identity_subject text not null check (identity_subject ~
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'),
  email_sha256 text not null check (email_sha256 ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('join','create_clinic')),
  requested_organization_id uuid references clinical_core.organizations(id),
  proposed_organization_label text,
  status text not null default 'pending'
    check (status in ('pending','approved','rejected','withdrawn')),
  approved_organization_id uuid references clinical_core.organizations(id),
  approved_membership_id uuid references clinical_core.organization_memberships(id),
  reviewer_person_id uuid references clinical_core.persons(id),
  operator_subject text,
  created_at timestamptz not null default clock_timestamp(),
  decided_at timestamptz,
  check ((kind='join' and requested_organization_id is not null
      and proposed_organization_label is null)
    or (kind='create_clinic' and requested_organization_id is null
      and proposed_organization_label is not null
      and char_length(proposed_organization_label) between 3 and 120)),
  check ((status='pending' and decided_at is null and approved_membership_id is null)
    or (status='withdrawn' and decided_at is not null and approved_membership_id is null)
    or (status='rejected' and decided_at is not null and approved_membership_id is null)
    or (status='approved' and decided_at is not null
      and approved_organization_id is not null and approved_membership_id is not null))
);
create unique index workforce_access_one_pending_per_subject
  on clinical_private.workforce_access_requests(identity_subject)
  where status='pending';
create index workforce_access_pending_clinic
  on clinical_private.workforce_access_requests(requested_organization_id,created_at,id)
  where status='pending' and kind='join';
create index workforce_access_subject_history
  on clinical_private.workforce_access_requests(identity_subject,created_at desc,id);
create index workforce_access_requested_org_fk
  on clinical_private.workforce_access_requests(requested_organization_id)
  where requested_organization_id is not null;
create index workforce_access_approved_org_fk
  on clinical_private.workforce_access_requests(approved_organization_id)
  where approved_organization_id is not null;
create index workforce_access_membership_fk
  on clinical_private.workforce_access_requests(approved_membership_id)
  where approved_membership_id is not null;
create index workforce_access_reviewer_fk
  on clinical_private.workforce_access_requests(reviewer_person_id)
  where reviewer_person_id is not null;
alter table clinical_private.workforce_access_requests enable row level security;
revoke all on clinical_private.workforce_access_requests
  from public,clinical_core_api,clinical_workforce_application,clinical_workforce_operator;

create table clinical_private.workforce_access_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references clinical_private.workforce_access_requests(id),
  action text not null check (action in ('submitted','withdrawn','approved','rejected')),
  reviewer_person_id uuid references clinical_core.persons(id),
  operator_subject text,
  occurred_at timestamptz not null default clock_timestamp()
);
create index workforce_access_events_request
  on clinical_private.workforce_access_events(request_id,occurred_at,id);
create index workforce_access_events_reviewer_fk
  on clinical_private.workforce_access_events(reviewer_person_id)
  where reviewer_person_id is not null;
alter table clinical_private.workforce_access_events enable row level security;
create trigger workforce_access_events_append_only before update or delete
  on clinical_private.workforce_access_events for each row
  execute function clinical_private.block_update_delete();
revoke all on clinical_private.workforce_access_events
  from public,clinical_core_api,clinical_workforce_application,clinical_workforce_operator;

create function clinical_private.submit_workforce_access_request(
  _request_id uuid,_subject text,_email_sha256 text,_kind text,
  _organization_id uuid default null,_proposed_label text default null
) returns uuid language plpgsql security definer set search_path='' as $$
declare _existing clinical_private.workforce_access_requests%rowtype;
begin
  if _request_id is null or _subject is null or _subject !~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
    or _email_sha256 is null or _email_sha256 !~ '^[0-9a-f]{64}$'
    or _kind not in ('join','create_clinic')
    or (_kind='join' and (_organization_id is null or _proposed_label is not null))
    or (_kind='create_clinic' and (_organization_id is not null
      or _proposed_label is null or char_length(btrim(_proposed_label)) not between 3 and 120
      or _proposed_label ~ '[[:cntrl:]]')) then
    raise exception using errcode='22023',message='workforce_application_invalid';
  end if;
  -- Serialize requests by subject; the partial unique index is a second line
  -- of defense, including across application processes.
  perform pg_advisory_xact_lock(hashtextextended(_subject,0));
  select * into _existing from clinical_private.workforce_access_requests
    where id=_request_id;
  if found then
    if _existing.identity_subject is distinct from _subject
      or _existing.email_sha256 is distinct from _email_sha256
      or _existing.kind is distinct from _kind
      or _existing.requested_organization_id is distinct from _organization_id
      or _existing.proposed_organization_label is distinct from
        nullif(btrim(coalesce(_proposed_label,'')),'') then
      raise exception using errcode='23505',message='workforce_application_request_conflict';
    end if;
    return _existing.id;
  end if;
  if exists (select 1 from clinical_private.workforce_access_requests
    where identity_subject=_subject and status='pending') then
    raise exception using errcode='23505',message='workforce_application_already_pending';
  end if;
  if _kind='join' and not exists (select 1 from clinical_core.organizations
    where id=_organization_id and status='active') then
    raise exception using errcode='P0002',message='workforce_clinic_unavailable';
  end if;
  insert into clinical_private.workforce_access_requests
    (id,identity_subject,email_sha256,kind,requested_organization_id,proposed_organization_label)
    values (_request_id,_subject,_email_sha256,_kind,_organization_id,
      case when _kind='create_clinic' then btrim(_proposed_label) else null end);
  insert into clinical_private.workforce_access_events(request_id,action)
    values (_request_id,'submitted');
  return _request_id;
end $$;

create function clinical_private.workforce_access_status_for_subject(_subject text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if _subject is null or _subject !~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' then
    raise exception using errcode='22023',message='workforce_subject_invalid';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id',r.id,'kind',r.kind,'status',r.status,'createdAt',r.created_at,
      'organizationId',coalesce(r.approved_organization_id,r.requested_organization_id))
      order by r.created_at desc,r.id)
    from (select * from clinical_private.workforce_access_requests
      where identity_subject=_subject order by created_at desc,id limit 50) r),'[]'::jsonb);
end $$;

create function clinical_private.withdraw_workforce_access_request(_request_id uuid,_subject text)
returns void language plpgsql security definer set search_path='' as $$
declare _request clinical_private.workforce_access_requests%rowtype;
begin
  if _request_id is null or _subject is null then
    raise exception using errcode='22023',message='workforce_application_invalid';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(_subject,0));
  select * into _request from clinical_private.workforce_access_requests
    where id=_request_id and identity_subject=_subject for update;
  if not found then raise exception using errcode='P0002',message='workforce_application_not_found'; end if;
  if _request.status='withdrawn' then return; end if;
  if _request.status<>'pending' then
    raise exception using errcode='22023',message='workforce_application_already_decided';
  end if;
  update clinical_private.workforce_access_requests
    set status='withdrawn',decided_at=clock_timestamp() where id=_request_id;
  insert into clinical_private.workforce_access_events(request_id,action)
    values (_request_id,'withdrawn');
end $$;

-- Called only inside an authorized clinic-admin or platform-operator review.
-- No applicant-facing or general API role may execute it directly.
create function clinical_private.bind_approved_workforce_subject(_subject text,_email_sha256 text)
returns uuid language plpgsql security definer set search_path='' as $$
declare _person uuid; _existing text; _new uuid;
begin
  select d.person_id,d.email_sha256 into _person,_existing
    from clinical_core.workforce_identity_directory d
    where d.identity_subject=_subject and d.status='active' for update;
  if _person is not null then
    if _existing<>_email_sha256 or not exists (
      select 1 from clinical_core.persons p
      join clinical_core.identities i on i.person_id=p.id
      where p.id=_person and p.status='active' and i.identity_pool='workforce'
        and i.identity_subject=_subject and i.status='active' and i.production_bound=true) then
      raise exception using errcode='42501',message='workforce_binding_conflict';
    end if;
    return _person;
  end if;
  _new:=gen_random_uuid();
  insert into clinical_core.persons(id,subject_key)
    values (_new,'subject_'||replace(_new::text,'-',''));
  insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound)
    values (_new,'workforce',_subject,true);
  insert into clinical_core.workforce_identity_directory(person_id,identity_subject,email_sha256)
    values (_new,_subject,_email_sha256);
  return _new;
end $$;

create function clinical_core.review_workforce_join_request(_request_id uuid,_approve boolean)
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

create function clinical_private.review_workforce_clinic_proposal(
  _request_id uuid,_approve boolean,_operator_subject text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare _request clinical_private.workforce_access_requests%rowtype;
  _person uuid; _organization uuid; _membership uuid;
begin
  if _request_id is null or _approve is null or _operator_subject is null
    or _operator_subject !~ '^[A-Za-z0-9:_-]{8,128}$' then
    raise exception using errcode='22023',message='workforce_review_invalid';
  end if;
  select * into _request from clinical_private.workforce_access_requests
    where id=_request_id and kind='create_clinic';
  if not found then raise exception using errcode='P0002',message='workforce_application_not_found'; end if;
  if _operator_subject=_request.identity_subject then
    raise exception using errcode='42501',message='workforce_self_approval_refused';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(_request.identity_subject,0));
  select * into _request from clinical_private.workforce_access_requests
    where id=_request_id and kind='create_clinic' for update;
  if _request.status<>'pending' then
    if (_request.status='approved') is distinct from _approve then
      raise exception using errcode='22023',message='workforce_review_conflict';
    end if;
    return jsonb_build_object('status',_request.status,
      'organizationId',_request.approved_organization_id,
      'membershipId',_request.approved_membership_id);
  end if;
  if _approve then
    _person:=clinical_private.bind_approved_workforce_subject(
      _request.identity_subject,_request.email_sha256);
    insert into clinical_core.organizations(organization_label)
      values (_request.proposed_organization_label) returning id into _organization;
    insert into clinical_core.organization_memberships(organization_id,person_id,role,status)
      values (_organization,_person,'owner','active') returning id into _membership;
  end if;
  update clinical_private.workforce_access_requests set
    status=case when _approve then 'approved' else 'rejected' end,
    approved_organization_id=_organization,approved_membership_id=_membership,
    operator_subject=_operator_subject,decided_at=clock_timestamp()
    where id=_request_id;
  insert into clinical_private.workforce_access_events(request_id,action,operator_subject)
    values (_request_id,case when _approve then 'approved' else 'rejected' end,
      _operator_subject);
  return jsonb_build_object('status',case when _approve then 'approved' else 'rejected' end,
    'organizationId',_organization,'membershipId',_membership);
end $$;

revoke all on function clinical_private.submit_workforce_access_request(uuid,text,text,text,uuid,text)
  from public,clinical_core_api,clinical_workforce_operator;
revoke all on function clinical_private.workforce_access_status_for_subject(text)
  from public,clinical_core_api,clinical_workforce_operator;
revoke all on function clinical_private.withdraw_workforce_access_request(uuid,text)
  from public,clinical_core_api,clinical_workforce_operator;
revoke all on function clinical_private.bind_approved_workforce_subject(text,text)
  from public,clinical_core_api,clinical_workforce_application,clinical_workforce_operator;
revoke all on function clinical_core.review_workforce_join_request(uuid,boolean)
  from public,clinical_workforce_application,clinical_workforce_operator;
revoke all on function clinical_private.review_workforce_clinic_proposal(uuid,boolean,text)
  from public,clinical_core_api,clinical_workforce_application;
grant execute on function clinical_private.submit_workforce_access_request(uuid,text,text,text,uuid,text)
  to clinical_workforce_application;
grant execute on function clinical_private.workforce_access_status_for_subject(text)
  to clinical_workforce_application;
grant execute on function clinical_private.withdraw_workforce_access_request(uuid,text)
  to clinical_workforce_application;
grant execute on function clinical_core.review_workforce_join_request(uuid,boolean)
  to clinical_core_api;
grant execute on function clinical_private.review_workforce_clinic_proposal(uuid,boolean,text)
  to clinical_workforce_operator;
