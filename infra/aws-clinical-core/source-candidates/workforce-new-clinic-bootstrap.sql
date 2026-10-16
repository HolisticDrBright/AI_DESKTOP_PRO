-- UNREGISTERED, BLOCKED source candidate (workforce-new-clinic-bootstrap). Applied nowhere, registered in no manifest;
-- no route, role or Lambda depends on it. Registration and execution are Codex work after the production security,
-- agreement, privacy and PHI reviews. Even once applied it does nothing until its release row is switched on by the
-- table owner; no API role can switch it.
--
-- Parents, applied in this order over the 106-migration production artifact:
--   source-candidates/workforce-token-binding-lookup.sql
--   source-candidates/workforce-clinic-approved-onboarding.sql
--   production-candidates/workforce-invitation-role-repair.sql
--   source-candidates/workforce-join-review-uniform-refusal.sql
--   source-candidates/workforce-current-membership-context.sql
--   source-candidates/workforce-onboarding-approval-authority.sql (SHA-256 534d6c8baa9781a76f34421b39ddac8de0612bca5b4e729d4af70be644ab8ffb)
-- Rollback: workforce-new-clinic-bootstrap-rollback.sql.
--
-- What it adds: a distinct door for a practitioner who creates a NEW clinic. Existing-clinic applicants are unchanged:
-- a join request still waits for the clinic's owner or admin, and an operator-reviewed clinic proposal is still held.
--
-- 1. One call, one transaction: the verified workforce subject becomes the active owner of a new, empty clinic, and
--    the current-membership setter admits them to that clinic at once. Nothing else: the call names no existing
--    clinic, so it cannot join, read or attach to one, and the new clinic starts with no patients, staff or records.
-- 2. The applicant service attests the account's assurance (`verified_email_and_mfa`: a confirmed address and an
--    active MFA method, read from the identity provider, never from the browser). Any other value is refused.
-- 3. Retries converge on the request id: the same request answers its stored result (`duplicate: true`) and its
--    current access; the same id with a different subject, address or name is a conflict and creates nothing.
-- 4. One bootstrapped clinic per subject. A second request id, from a retry that lost its id or a second tab, is
--    refused by name, and a pending operator proposal for a new clinic must be withdrawn first.
-- 5. Concurrent sign-ups: a per-subject transaction lock serializes one subject's calls (the second waits, then sees
--    the first); different subjects never wait for each other and always get different clinics, whatever the name.
-- 6. A registered platform operator is never a bootstrapping subject: operators sign in separately, with MFA, and
--    their door is the operator role, not this one.
-- 7. Revocation: an active platform operator may suspend a bootstrapped clinic with a closed-vocabulary reason. The
--    clinic and its owner membership become suspended in the same transaction, so the setter refuses the owner and
--    any staff from then on; a request already admitted finishes first (the setter holds its rows FOR SHARE). A
--    replayed bootstrap after a suspension answers `not_available` and restores nothing; there is no un-suspend here.
-- 8. A switched-account retry cannot reach another subject's clinic: the request id is bound to its subject.

create table clinical_private.workforce_clinic_bootstrap_release (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  changed_at timestamptz not null default clock_timestamp()
);
insert into clinical_private.workforce_clinic_bootstrap_release(singleton,enabled) values (true,false);
alter table clinical_private.workforce_clinic_bootstrap_release enable row level security;
revoke all on clinical_private.workforce_clinic_bootstrap_release
  from public,clinical_core_api,clinical_workforce_application,clinical_workforce_operator;

create table clinical_private.workforce_clinic_bootstraps (
  request_id uuid primary key,
  identity_subject text not null check (identity_subject ~
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'),
  email_sha256 text not null check (email_sha256 ~ '^[0-9a-f]{64}$'),
  clinic_label text not null check (char_length(clinic_label) between 3 and 120),
  assurance text not null check (assurance = 'verified_email_and_mfa'),
  person_id uuid not null references clinical_core.persons(id),
  organization_id uuid not null unique references clinical_core.organizations(id),
  membership_id uuid not null unique references clinical_core.organization_memberships(id),
  status text not null default 'active' check (status in ('active','suspended')),
  created_at timestamptz not null default clock_timestamp(),
  suspended_at timestamptz,
  suspension_reason text check (suspension_reason is null or suspension_reason in
    ('security_concern','identity_not_verified','agreement_not_accepted','operator_request')),
  operator_subject text,
  check ((status='active' and suspended_at is null and suspension_reason is null and operator_subject is null)
    or (status='suspended' and suspended_at is not null and suspension_reason is not null and operator_subject is not null))
);
create unique index workforce_clinic_bootstraps_one_per_subject
  on clinical_private.workforce_clinic_bootstraps(lower(identity_subject));
create index workforce_clinic_bootstraps_person_fk on clinical_private.workforce_clinic_bootstraps(person_id);
alter table clinical_private.workforce_clinic_bootstraps enable row level security;
revoke all on clinical_private.workforce_clinic_bootstraps
  from public,clinical_core_api,clinical_workforce_application,clinical_workforce_operator;

create table clinical_private.workforce_clinic_bootstrap_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references clinical_private.workforce_clinic_bootstraps(request_id),
  action text not null check (action in ('bootstrapped','suspended')),
  operator_subject text,
  reason_code text check (reason_code is null or reason_code in
    ('security_concern','identity_not_verified','agreement_not_accepted','operator_request')),
  occurred_at timestamptz not null default clock_timestamp(),
  check ((action='bootstrapped' and operator_subject is null and reason_code is null)
    or (action='suspended' and operator_subject is not null and reason_code is not null))
);
create index workforce_clinic_bootstrap_events_request
  on clinical_private.workforce_clinic_bootstrap_events(request_id,occurred_at,id);
alter table clinical_private.workforce_clinic_bootstrap_events enable row level security;
create trigger workforce_clinic_bootstrap_events_append_only before update or delete
  on clinical_private.workforce_clinic_bootstrap_events for each row
  execute function clinical_private.block_update_delete();
revoke all on clinical_private.workforce_clinic_bootstrap_events
  from public,clinical_core_api,clinical_workforce_application,clinical_workforce_operator;

-- Whether this bootstrap gives clinical access now: exactly the rows the current-membership setter checks.
create function clinical_private.workforce_clinic_bootstrap_access(_bootstrap clinical_private.workforce_clinic_bootstraps)
returns text language sql stable security definer set search_path='' as $$
  select case when _bootstrap.status='active' and exists (
      select 1 from clinical_core.organization_memberships m
      join clinical_core.organizations o on o.id=m.organization_id
      where m.id=_bootstrap.membership_id and m.status='active' and m.role='owner' and o.status='active')
    then 'available' else 'not_available' end
$$;

create function clinical_private.bootstrap_workforce_clinic(
  _request_id uuid,_subject text,_email_sha256 text,_clinic_label text,_assurance text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare _existing clinical_private.workforce_clinic_bootstraps%rowtype;
  _label text; _person uuid; _organization uuid; _membership uuid; _constraint text;
begin
  _label:=btrim(_clinic_label);
  if _request_id is null or _subject is null or _subject !~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
    or _email_sha256 is null or _email_sha256 !~ '^[0-9a-f]{64}$'
    or _label is null or char_length(_label) not between 3 and 120 or _assurance is null then
    raise exception using errcode='22023',message='workforce_bootstrap_invalid';
  end if;
  if _assurance<>'verified_email_and_mfa' then
    raise exception using errcode='42501',message='workforce_bootstrap_assurance_required';
  end if;
  if not coalesce((select enabled from clinical_private.workforce_clinic_bootstrap_release where singleton for share),false) then
    raise exception using errcode='42501',message='workforce_clinic_bootstrap_not_released';
  end if;
  if exists (select 1 from clinical_private.workforce_platform_operators where lower(operator_subject)=lower(_subject)) then
    raise exception using errcode='42501',message='workforce_operator_refused';
  end if;
  -- One subject's bootstraps run one at a time (the key the proposal review uses for the same subject).
  perform pg_advisory_xact_lock(hashtextextended(lower(_subject),0));
  select * into _existing from clinical_private.workforce_clinic_bootstraps where request_id=_request_id;
  if found then
    if lower(_existing.identity_subject)<>lower(_subject) or _existing.email_sha256<>_email_sha256
      or _existing.clinic_label<>_label then
      raise exception using errcode='22023',message='workforce_bootstrap_conflict';
    end if;
    return jsonb_build_object('requestId',_existing.request_id,'organizationId',_existing.organization_id,
      'membershipId',_existing.membership_id,'status',_existing.status,
      'clinicalAccess',clinical_private.workforce_clinic_bootstrap_access(_existing),'duplicate',true);
  end if;
  if exists (select 1 from clinical_private.workforce_clinic_bootstraps where lower(identity_subject)=lower(_subject)) then
    raise exception using errcode='22023',message='workforce_clinic_bootstrap_exists';
  end if;
  if exists (select 1 from clinical_private.workforce_access_requests
      where lower(identity_subject)=lower(_subject) and kind='create_clinic' and status='pending') then
    raise exception using errcode='22023',message='workforce_request_pending';
  end if;
  if exists (select 1 from clinical_core.workforce_identity_directory d
      where d.email_sha256=_email_sha256 and lower(d.identity_subject)<>lower(_subject)) then
    raise exception using errcode='42501',message='workforce_binding_conflict';
  end if;
  -- Two accounts with one address may race past the check above under their own subject locks; the directory's unique
  -- address index then decides, and the account that loses is refused by name, never with the index's own error.
  begin
    _person:=clinical_private.bind_approved_workforce_subject(_subject,_email_sha256);
  exception when unique_violation then
    get stacked diagnostics _constraint = constraint_name;
    if _constraint = 'workforce_identity_directory_email_sha256_key' then
      raise exception using errcode='42501',message='workforce_binding_conflict';
    end if;
    raise;
  end;
  insert into clinical_core.organizations(organization_label) values (_label) returning id into _organization;
  insert into clinical_core.organization_memberships(organization_id,person_id,role,status)
    values (_organization,_person,'owner','active') returning id into _membership;
  insert into clinical_private.workforce_clinic_bootstraps(request_id,identity_subject,email_sha256,clinic_label,
      assurance,person_id,organization_id,membership_id)
    values (_request_id,_subject,_email_sha256,_label,_assurance,_person,_organization,_membership);
  insert into clinical_private.workforce_clinic_bootstrap_events(request_id,action) values (_request_id,'bootstrapped');
  return jsonb_build_object('requestId',_request_id,'organizationId',_organization,'membershipId',_membership,
    'status','active','clinicalAccess','available','duplicate',false);
end $$;

-- The applicant's own bootstrapped clinic, if any: ids, state and access, never another subject's rows.
create function clinical_private.workforce_clinic_bootstrap_for_subject(_subject text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare _bootstrap clinical_private.workforce_clinic_bootstraps%rowtype;
begin
  if _subject is null or _subject !~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' then
    raise exception using errcode='22023',message='workforce_subject_invalid';
  end if;
  select * into _bootstrap from clinical_private.workforce_clinic_bootstraps where lower(identity_subject)=lower(_subject);
  if not found then return null; end if;
  return jsonb_build_object('requestId',_bootstrap.request_id,'organizationId',_bootstrap.organization_id,
    'status',_bootstrap.status,'suspensionReason',_bootstrap.suspension_reason,
    'clinicalAccess',clinical_private.workforce_clinic_bootstrap_access(_bootstrap),'createdAt',_bootstrap.created_at);
end $$;

-- Revocation by a platform operator: the whole bootstrapped clinic and its owner membership, with a reason.
create function clinical_private.suspend_bootstrapped_workforce_clinic(
  _organization_id uuid,_operator_subject text,_reason text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare _bootstrap clinical_private.workforce_clinic_bootstraps%rowtype;
begin
  if _organization_id is null or _operator_subject is null or _reason is null or _reason not in
      ('security_concern','identity_not_verified','agreement_not_accepted','operator_request') then
    raise exception using errcode='22023',message='workforce_bootstrap_suspension_invalid';
  end if;
  if not exists (select 1 from clinical_private.workforce_platform_operators
      where operator_subject=_operator_subject and status='active' for share) then
    raise exception using errcode='42501',message='workforce_operator_refused';
  end if;
  select * into _bootstrap from clinical_private.workforce_clinic_bootstraps where organization_id=_organization_id;
  if not found then raise exception using errcode='P0002',message='workforce_clinic_bootstrap_not_found'; end if;
  if lower(_operator_subject)=lower(_bootstrap.identity_subject) or exists (
      select 1 from clinical_core.workforce_identity_directory d
      where lower(d.identity_subject)=lower(_operator_subject) and d.email_sha256=_bootstrap.email_sha256) then
    raise exception using errcode='42501',message='workforce_self_approval_refused';
  end if;
  -- The setter's lock order (clinic, then membership), so an admitted request finishes before the suspension lands.
  perform 1 from clinical_core.organizations where id=_organization_id for update;
  select * into _bootstrap from clinical_private.workforce_clinic_bootstraps where organization_id=_organization_id for update;
  if _bootstrap.status='suspended' then
    return jsonb_build_object('organizationId',_organization_id,'status','suspended',
      'reason',_bootstrap.suspension_reason,'duplicate',true);
  end if;
  update clinical_core.organizations set status='suspended' where id=_organization_id;
  update clinical_core.organization_memberships set status='suspended' where id=_bootstrap.membership_id;
  update clinical_private.workforce_clinic_bootstraps set status='suspended',suspended_at=clock_timestamp(),
    suspension_reason=_reason,operator_subject=_operator_subject where request_id=_bootstrap.request_id;
  insert into clinical_private.workforce_clinic_bootstrap_events(request_id,action,operator_subject,reason_code)
    values (_bootstrap.request_id,'suspended',_operator_subject,_reason);
  return jsonb_build_object('organizationId',_organization_id,'status','suspended','reason',_reason,'duplicate',false);
end $$;

revoke all on function clinical_private.workforce_clinic_bootstrap_access(clinical_private.workforce_clinic_bootstraps) from public;
revoke all on function clinical_private.bootstrap_workforce_clinic(uuid,text,text,text,text) from public;
revoke all on function clinical_private.workforce_clinic_bootstrap_for_subject(text) from public;
revoke all on function clinical_private.suspend_bootstrapped_workforce_clinic(uuid,text,text) from public;
grant execute on function clinical_private.bootstrap_workforce_clinic(uuid,text,text,text,text) to clinical_workforce_application;
grant execute on function clinical_private.workforce_clinic_bootstrap_for_subject(text) to clinical_workforce_application;
grant execute on function clinical_private.suspend_bootstrapped_workforce_clinic(uuid,text,text) to clinical_workforce_operator;
