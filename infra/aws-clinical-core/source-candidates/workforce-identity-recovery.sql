-- UNREGISTERED, BLOCKED source candidate (workforce-identity-recovery). Applied nowhere, registered in no manifest; no
-- route, role or Lambda depends on it, and no Desktop route calls it. Even once applied it does nothing until the table
-- owner records the three release decisions Brandon has NOT made: the identity-verification method, the approver
-- roster, and the retention policy. No API or operator role can record them.
--
-- Parent: workforce-identity-emergency-revocation.sql, applied (its tables, and set_request_context at prosrc SHA-256
-- 3ee98d29830ee366a1c670c236cbf018b710eb7dbbc48d3ee090e7d66c36097b).
-- Rollback: workforce-identity-recovery-rollback.sql (removes the routes, keeps every record and the retired-subject
-- guard, and undoes no recovery).
--
-- Brandon approved the principle: lawful access to patient files must remain possible after a login is revoked, through
-- a separately verified route. This file is that route's contract, in two parts, and invents no identity proof.
--
-- 1. A REPLACEMENT CREDENTIAL for a practitioner whose login was revoked. One operator proposes binding the revoked
--    workforce identity to a new, MFA-protected account (the service attests the assurance from the identity provider);
--    an approver on the roster, never the proposer, approves. Then, in one transaction, the old subject is RETIRED and the
--    identity carries the new subject, active again, with every membership it had. The old subject never regains
--    authority: a trigger refuses any identity or directory row that names a retired subject, for every writer, so
--    neither a rebind, a retry nor a new account can bring it back. Only an identity the emergency revocation disabled
--    can be recovered, so this is not a door to take over a working login.
-- 2. CUSTODIAL ACCESS to one named patient's file in one clinic, read-only and time-bounded: requested by one operator,
--    approved by a different operator on the roster, and readable only by the requesting operator until it expires.
--    Every read is logged, append-only. Nothing here changes a clinic's status, a membership or a patient record.
--
-- The patient file returned is the patient record's own fields. A wider chart scope, and how long these records are
-- kept, are release decisions; until they are recorded nothing here runs.

begin;

do $guard$
begin
  if to_regclass('clinical_private.workforce_identity_revocations') is null
    or to_regclass('clinical_private.workforce_platform_operators') is null
    or (select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') from pg_proc p
      where p.oid = to_regprocedure('clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)'))
      is distinct from '3ee98d29830ee366a1c670c236cbf018b710eb7dbbc48d3ee090e7d66c36097b' then
    raise exception using errcode = '55000', message = 'identity_recovery_parent_refused';
  end if;
end
$guard$;

-- The release: off until the three decisions are recorded. Each is a reviewed code the owner writes, not a default.
create table clinical_private.workforce_identity_recovery_release (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  verification_method text check (verification_method is null or verification_method ~ '^[a-z][a-z0-9_]{2,63}$'),
  retention_policy text check (retention_policy is null or retention_policy ~ '^[a-z][a-z0-9_]{2,63}$'),
  custodial_max_hours integer check (custodial_max_hours is null or custodial_max_hours between 1 and 168),
  changed_at timestamptz not null default clock_timestamp(),
  check (not enabled or (verification_method is not null and retention_policy is not null and custodial_max_hours is not null))
);
insert into clinical_private.workforce_identity_recovery_release(singleton) values (true);

-- The approver roster: empty. Only the table owner adds an approver.
create table clinical_private.workforce_identity_recovery_approvers (
  operator_subject text primary key check (operator_subject ~
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'),
  status text not null default 'active' check (status in ('active','disabled')),
  added_at timestamptz not null default clock_timestamp()
);

create table clinical_private.workforce_retired_identity_subjects (
  identity_subject text primary key check (identity_subject ~ '^[A-Za-z0-9:_-]{8,128}$'),
  identity_id uuid not null references clinical_core.identities(id),
  retired_at timestamptz not null default clock_timestamp()
);
create unique index workforce_retired_identity_subjects_lower_idx on clinical_private.workforce_retired_identity_subjects(lower(identity_subject));

create table clinical_private.workforce_identity_recovery_proposals (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  identity_id uuid not null references clinical_core.identities(id),
  revoked_subject text not null check (revoked_subject ~ '^[A-Za-z0-9:_-]{8,128}$'),
  replacement_subject text not null check (replacement_subject ~ '^[A-Za-z0-9:_-]{8,128}$'),
  replacement_email_sha256 text not null check (replacement_email_sha256 ~ '^[0-9a-f]{64}$'),
  verification_method text not null,
  verification_evidence_sha256 text not null check (verification_evidence_sha256 ~ '^[0-9a-f]{64}$'),
  replacement_assurance text not null check (replacement_assurance = 'mfa_totp_enrolled'),
  proposed_by text not null,
  proposed_at timestamptz not null default clock_timestamp()
);
create table clinical_private.workforce_identity_recovery_decisions (
  proposal_id uuid primary key references clinical_private.workforce_identity_recovery_proposals(id),
  decision text not null check (decision in ('approved','declined')),
  decided_by text not null,
  decided_at timestamptz not null default clock_timestamp()
);

create table clinical_private.workforce_custodial_access_grants (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null,
  reason_code text not null check (reason_code in ('practitioner_login_revoked','clinic_without_administrator','patient_request','legal_request')),
  duration_hours integer not null check (duration_hours between 1 and 168),
  requested_by text not null,
  requested_at timestamptz not null default clock_timestamp(),
  foreign key (patient_record_id, organization_id) references clinical_core.patient_records(id, organization_id)
);
create table clinical_private.workforce_custodial_access_decisions (
  grant_id uuid primary key references clinical_private.workforce_custodial_access_grants(id),
  decision text not null check (decision in ('approved','declined')),
  decided_by text not null,
  decided_at timestamptz not null default clock_timestamp()
);
create table clinical_private.workforce_custodial_access_log (
  id uuid primary key default gen_random_uuid(),
  grant_id uuid not null references clinical_private.workforce_custodial_access_grants(id),
  operator_subject text not null,
  patient_record_id uuid not null,
  accessed_at timestamptz not null default clock_timestamp()
);

create function clinical_private.workforce_identity_recovery_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = '55000', message = 'append_only_record';
end $$;
do $append_only$
declare _table text;
begin
  foreach _table in array array['workforce_retired_identity_subjects','workforce_identity_recovery_proposals',
      'workforce_identity_recovery_decisions','workforce_custodial_access_grants','workforce_custodial_access_decisions',
      'workforce_custodial_access_log'] loop
    execute format('create trigger %I before update or delete on clinical_private.%I for each row execute function clinical_private.workforce_identity_recovery_append_only()',
      _table || '_append_only', _table);
    execute format('create trigger %I before truncate on clinical_private.%I for each statement execute function clinical_private.workforce_identity_recovery_append_only()',
      _table || '_no_truncate', _table);
    execute format('alter table clinical_private.%I enable row level security', _table);
    execute format('revoke all on clinical_private.%I from public, clinical_core_api, clinical_workforce_application, clinical_workforce_operator', _table);
  end loop;
end
$append_only$;
alter table clinical_private.workforce_identity_recovery_release enable row level security;
alter table clinical_private.workforce_identity_recovery_approvers enable row level security;
revoke all on clinical_private.workforce_identity_recovery_release, clinical_private.workforce_identity_recovery_approvers
  from public, clinical_core_api, clinical_workforce_application, clinical_workforce_operator;

-- A retired subject is never an identity again, whoever writes the row.
create function clinical_private.refuse_retired_identity_subject()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from clinical_private.workforce_retired_identity_subjects r
      where lower(r.identity_subject) = lower(new.identity_subject)) then
    raise exception using errcode = '42501', message = 'workforce_identity_subject_retired';
  end if;
  return new;
end $$;
create trigger identities_refuse_retired_subject before insert or update of identity_subject on clinical_core.identities
  for each row execute function clinical_private.refuse_retired_identity_subject();
create trigger workforce_identity_directory_refuse_retired_subject before insert or update of identity_subject on clinical_core.workforce_identity_directory
  for each row execute function clinical_private.refuse_retired_identity_subject();

create function clinical_private.require_identity_recovery_release()
returns clinical_private.workforce_identity_recovery_release language plpgsql stable security definer set search_path = '' as $$
declare _release clinical_private.workforce_identity_recovery_release%rowtype;
begin
  select * into _release from clinical_private.workforce_identity_recovery_release where singleton;
  if not found or not _release.enabled then
    raise exception using errcode = '55000', message = 'workforce_identity_recovery_not_released';
  end if;
  return _release;
end $$;

-- An approver: an active platform operator who is also on the recovery roster, and not the proposer.
create function clinical_private.require_recovery_approver(_operator_subject text, _proposer text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform clinical_private.require_active_platform_operator(_operator_subject);
  if not exists (select 1 from clinical_private.workforce_identity_recovery_approvers
      where operator_subject = _operator_subject and status = 'active' for share) then
    raise exception using errcode = '42501', message = 'workforce_operator_refused';
  end if;
  if lower(_operator_subject) = lower(_proposer) then
    raise exception using errcode = '42501', message = 'workforce_independent_operator_required';
  end if;
end $$;

create function clinical_private.workforce_identity_recovery_summary(_proposal_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('proposalId', p.id, 'requestId', p.request_id, 'proposedAt', p.proposed_at,
    'state', coalesce(d.decision, 'awaiting_approval'), 'decidedAt', d.decided_at)
  from clinical_private.workforce_identity_recovery_proposals p
  left join clinical_private.workforce_identity_recovery_decisions d on d.proposal_id = p.id
  where p.id = _proposal_id
$$;

create function clinical_private.propose_workforce_identity_recovery(
  _operator_subject text, _request_id uuid, _revoked_subject text, _replacement_subject text, _replacement_email_sha256 text,
  _verification_method text, _verification_evidence_sha256 text, _replacement_assurance text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare _release clinical_private.workforce_identity_recovery_release%rowtype;
  _existing clinical_private.workforce_identity_recovery_proposals%rowtype;
  _identity clinical_core.identities%rowtype;
  _id uuid;
begin
  _release := clinical_private.require_identity_recovery_release();
  perform clinical_private.require_active_platform_operator(_operator_subject);
  if _request_id is null or _revoked_subject is null or _replacement_subject is null
    or _replacement_subject !~ '^[A-Za-z0-9:_-]{8,128}$' or lower(_replacement_subject) = lower(_revoked_subject)
    or _replacement_email_sha256 is null or _replacement_email_sha256 !~ '^[0-9a-f]{64}$'
    or _verification_evidence_sha256 is null or _verification_evidence_sha256 !~ '^[0-9a-f]{64}$'
    or _verification_method is distinct from _release.verification_method
    or _replacement_assurance is distinct from 'mfa_totp_enrolled' then
    raise exception using errcode = '22023', message = 'workforce_identity_recovery_invalid';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('workforce-identity-recovery/' || _request_id::text, 0));
  select * into _existing from clinical_private.workforce_identity_recovery_proposals where request_id = _request_id;
  if found then
    if _existing.proposed_by <> _operator_subject or _existing.revoked_subject <> _revoked_subject
      or _existing.replacement_subject <> _replacement_subject or _existing.replacement_email_sha256 <> _replacement_email_sha256
      or _existing.verification_evidence_sha256 <> _verification_evidence_sha256 then
      raise exception using errcode = '23505', message = 'workforce_identity_recovery_conflict';
    end if;
    return clinical_private.workforce_identity_recovery_summary(_existing.id) || jsonb_build_object('duplicate', true);
  end if;
  if exists (select 1 from clinical_private.workforce_retired_identity_subjects r where lower(r.identity_subject) = lower(_replacement_subject)) then
    raise exception using errcode = '42501', message = 'workforce_identity_subject_retired';
  end if;
  select * into _identity from clinical_core.identities
    where identity_pool = 'workforce' and identity_subject = _revoked_subject for update;
  -- Only a login the emergency revocation disabled can be given a replacement.
  if not found or _identity.status <> 'disabled'
    or not exists (select 1 from clinical_private.workforce_identity_revocations r where r.identity_id = _identity.id) then
    raise exception using errcode = '22023', message = 'workforce_identity_recovery_invalid';
  end if;
  perform clinical_private.require_not_own_workforce_login(_operator_subject, _identity.id);
  if exists (select 1 from clinical_core.identities i where lower(i.identity_subject) = lower(_replacement_subject))
    or exists (select 1 from clinical_core.workforce_identity_directory d
      where lower(d.identity_subject) = lower(_replacement_subject)
        or (d.email_sha256 = _replacement_email_sha256 and d.person_id <> _identity.person_id)) then
    raise exception using errcode = '23505', message = 'workforce_identity_recovery_conflict';
  end if;
  insert into clinical_private.workforce_identity_recovery_proposals(request_id, identity_id, revoked_subject, replacement_subject,
      replacement_email_sha256, verification_method, verification_evidence_sha256, replacement_assurance, proposed_by)
    values (_request_id, _identity.id, _revoked_subject, _replacement_subject, _replacement_email_sha256, _verification_method,
      _verification_evidence_sha256, _replacement_assurance, _operator_subject) returning id into _id;
  return clinical_private.workforce_identity_recovery_summary(_id) || jsonb_build_object('duplicate', false);
end $$;

create function clinical_private.decide_workforce_identity_recovery(_operator_subject text, _proposal_id uuid, _approve boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare _p clinical_private.workforce_identity_recovery_proposals%rowtype;
  _d clinical_private.workforce_identity_recovery_decisions%rowtype;
  _identity clinical_core.identities%rowtype;
  _recorded text := case when _approve then 'approved' when not _approve then 'declined' end;
begin
  perform clinical_private.require_identity_recovery_release();
  if _proposal_id is null or _recorded is null then
    raise exception using errcode = '22023', message = 'workforce_identity_recovery_invalid';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('workforce-identity-recovery-decision/' || _proposal_id::text, 0));
  select * into _p from clinical_private.workforce_identity_recovery_proposals where id = _proposal_id;
  if not found then raise exception using errcode = 'P0002', message = 'workforce_identity_revocation_not_found'; end if;
  perform clinical_private.require_recovery_approver(_operator_subject, _p.proposed_by);
  perform clinical_private.require_not_own_workforce_login(_operator_subject, _p.identity_id);
  select * into _d from clinical_private.workforce_identity_recovery_decisions where proposal_id = _proposal_id;
  if found then
    if _d.decided_by <> _operator_subject or _d.decision <> _recorded then
      raise exception using errcode = '23505', message = 'workforce_identity_recovery_conflict';
    end if;
    return clinical_private.workforce_identity_recovery_summary(_proposal_id) || jsonb_build_object('duplicate', true);
  end if;
  if _approve then
    -- Every fact the proposal relied on is read again, under the identity's own lock.
    select * into _identity from clinical_core.identities where id = _p.identity_id for update;
    if _identity.identity_subject <> _p.revoked_subject or _identity.status <> 'disabled' then
      raise exception using errcode = '23505', message = 'workforce_identity_recovery_conflict';
    end if;
    insert into clinical_private.workforce_retired_identity_subjects(identity_subject, identity_id) values (_p.revoked_subject, _p.identity_id);
    update clinical_core.identities set identity_subject = _p.replacement_subject, status = 'active' where id = _p.identity_id;
    update clinical_core.workforce_identity_directory set identity_subject = _p.replacement_subject, email_sha256 = _p.replacement_email_sha256
      where person_id = _identity.person_id;
  end if;
  insert into clinical_private.workforce_identity_recovery_decisions(proposal_id, decision, decided_by) values (_proposal_id, _recorded, _operator_subject);
  return clinical_private.workforce_identity_recovery_summary(_proposal_id) || jsonb_build_object('duplicate', false);
end $$;

create function clinical_private.workforce_custodial_access_summary(_grant_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('grantId', g.id, 'requestId', g.request_id, 'organizationId', g.organization_id,
    'patientRecordId', g.patient_record_id, 'reason', g.reason_code, 'durationHours', g.duration_hours,
    'state', coalesce(d.decision, 'awaiting_approval'),
    'expiresAt', case when d.decision = 'approved' then d.decided_at + make_interval(hours => g.duration_hours) end)
  from clinical_private.workforce_custodial_access_grants g
  left join clinical_private.workforce_custodial_access_decisions d on d.grant_id = g.id
  where g.id = _grant_id
$$;

create function clinical_private.request_workforce_custodial_access(
  _operator_subject text, _request_id uuid, _organization_id uuid, _patient_record_id uuid, _reason text, _hours integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare _release clinical_private.workforce_identity_recovery_release%rowtype;
  _existing clinical_private.workforce_custodial_access_grants%rowtype;
  _id uuid;
begin
  _release := clinical_private.require_identity_recovery_release();
  perform clinical_private.require_active_platform_operator(_operator_subject);
  if _request_id is null or _organization_id is null or _patient_record_id is null or _hours is null
    or _hours < 1 or _hours > _release.custodial_max_hours
    or _reason is null or _reason not in ('practitioner_login_revoked','clinic_without_administrator','patient_request','legal_request') then
    raise exception using errcode = '22023', message = 'workforce_identity_recovery_invalid';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('workforce-custodial-access/' || _request_id::text, 0));
  select * into _existing from clinical_private.workforce_custodial_access_grants where request_id = _request_id;
  if found then
    if _existing.requested_by <> _operator_subject or _existing.organization_id <> _organization_id
      or _existing.patient_record_id <> _patient_record_id or _existing.reason_code <> _reason or _existing.duration_hours <> _hours then
      raise exception using errcode = '23505', message = 'workforce_identity_recovery_conflict';
    end if;
    return clinical_private.workforce_custodial_access_summary(_existing.id) || jsonb_build_object('duplicate', true);
  end if;
  -- One named patient of that one clinic: a patient of another clinic is refused by name, without saying whether it exists.
  if not exists (select 1 from clinical_core.patient_records r where r.id = _patient_record_id and r.organization_id = _organization_id) then
    raise exception using errcode = '42501', message = 'workforce_custodial_access_refused';
  end if;
  insert into clinical_private.workforce_custodial_access_grants(request_id, organization_id, patient_record_id, reason_code, duration_hours, requested_by)
    values (_request_id, _organization_id, _patient_record_id, _reason, _hours, _operator_subject) returning id into _id;
  return clinical_private.workforce_custodial_access_summary(_id) || jsonb_build_object('duplicate', false);
end $$;

create function clinical_private.decide_workforce_custodial_access(_operator_subject text, _grant_id uuid, _approve boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare _g clinical_private.workforce_custodial_access_grants%rowtype;
  _d clinical_private.workforce_custodial_access_decisions%rowtype;
  _recorded text := case when _approve then 'approved' when not _approve then 'declined' end;
begin
  perform clinical_private.require_identity_recovery_release();
  if _grant_id is null or _recorded is null then
    raise exception using errcode = '22023', message = 'workforce_identity_recovery_invalid';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('workforce-custodial-access-decision/' || _grant_id::text, 0));
  select * into _g from clinical_private.workforce_custodial_access_grants where id = _grant_id;
  if not found then raise exception using errcode = '42501', message = 'workforce_custodial_access_refused'; end if;
  perform clinical_private.require_recovery_approver(_operator_subject, _g.requested_by);
  select * into _d from clinical_private.workforce_custodial_access_decisions where grant_id = _grant_id;
  if found then
    if _d.decided_by <> _operator_subject or _d.decision <> _recorded then
      raise exception using errcode = '23505', message = 'workforce_identity_recovery_conflict';
    end if;
    return clinical_private.workforce_custodial_access_summary(_grant_id) || jsonb_build_object('duplicate', true);
  end if;
  insert into clinical_private.workforce_custodial_access_decisions(grant_id, decision, decided_by) values (_grant_id, _recorded, _operator_subject);
  return clinical_private.workforce_custodial_access_summary(_grant_id) || jsonb_build_object('duplicate', false);
end $$;

-- The read: the requesting operator, the named patient, an approved and unexpired grant. Read-only on clinical data;
-- the only write is the access log entry, in the same transaction.
create function clinical_private.read_workforce_custodial_patient_file(_operator_subject text, _grant_id uuid, _patient_record_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare _g clinical_private.workforce_custodial_access_grants%rowtype;
  _d clinical_private.workforce_custodial_access_decisions%rowtype;
  _file jsonb;
begin
  perform clinical_private.require_identity_recovery_release();
  perform clinical_private.require_active_platform_operator(_operator_subject);
  select * into _g from clinical_private.workforce_custodial_access_grants where id = _grant_id;
  select * into _d from clinical_private.workforce_custodial_access_decisions where grant_id = _grant_id;
  if _g.id is null or _d.decision is distinct from 'approved' or _g.requested_by <> _operator_subject
    or _patient_record_id is distinct from _g.patient_record_id
    or clock_timestamp() >= _d.decided_at + make_interval(hours => _g.duration_hours) then
    raise exception using errcode = '42501', message = 'workforce_custodial_access_refused';
  end if;
  select jsonb_build_object('patientRecordId', r.id, 'organizationId', r.organization_id, 'patientKey', r.patient_key, 'mrn', r.mrn,
      'firstName', r.first_name, 'lastName', r.last_name, 'dateOfBirth', r.date_of_birth, 'sex', r.sex, 'status', r.status, 'createdAt', r.created_at)
    into _file from clinical_core.patient_records r where r.id = _g.patient_record_id and r.organization_id = _g.organization_id;
  if _file is null then raise exception using errcode = '42501', message = 'workforce_custodial_access_refused'; end if;
  insert into clinical_private.workforce_custodial_access_log(grant_id, operator_subject, patient_record_id) values (_g.id, _operator_subject, _g.patient_record_id);
  return jsonb_build_object('scope', 'patient_record', 'readOnly', true, 'grantId', _g.id,
    'expiresAt', _d.decided_at + make_interval(hours => _g.duration_hours), 'file', _file);
end $$;

revoke all on function clinical_private.workforce_identity_recovery_append_only() from public;
revoke all on function clinical_private.refuse_retired_identity_subject() from public;
revoke all on function clinical_private.require_identity_recovery_release() from public;
revoke all on function clinical_private.require_recovery_approver(text,text) from public;
revoke all on function clinical_private.workforce_identity_recovery_summary(uuid) from public;
revoke all on function clinical_private.workforce_custodial_access_summary(uuid) from public;
revoke all on function clinical_private.propose_workforce_identity_recovery(text,uuid,text,text,text,text,text,text) from public;
revoke all on function clinical_private.decide_workforce_identity_recovery(text,uuid,boolean) from public;
revoke all on function clinical_private.request_workforce_custodial_access(text,uuid,uuid,uuid,text,integer) from public;
revoke all on function clinical_private.decide_workforce_custodial_access(text,uuid,boolean) from public;
revoke all on function clinical_private.read_workforce_custodial_patient_file(text,uuid,uuid) from public;
grant execute on function clinical_private.propose_workforce_identity_recovery(text,uuid,text,text,text,text,text,text) to clinical_workforce_operator;
grant execute on function clinical_private.decide_workforce_identity_recovery(text,uuid,boolean) to clinical_workforce_operator;
grant execute on function clinical_private.request_workforce_custodial_access(text,uuid,uuid,uuid,text,integer) to clinical_workforce_operator;
grant execute on function clinical_private.decide_workforce_custodial_access(text,uuid,boolean) to clinical_workforce_operator;
grant execute on function clinical_private.read_workforce_custodial_patient_file(text,uuid,uuid) to clinical_workforce_operator;

do $check$
begin
  if exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.pronamespace = 'clinical_private'::regnamespace and a.grantee = 0
        and p.proname in ('propose_workforce_identity_recovery','decide_workforce_identity_recovery','request_workforce_custodial_access',
          'decide_workforce_custodial_access','read_workforce_custodial_patient_file','refuse_retired_identity_subject'))
    or has_function_privilege('clinical_core_api', 'clinical_private.read_workforce_custodial_patient_file(text,uuid,uuid)', 'execute')
    or has_function_privilege('clinical_core_api', 'clinical_private.decide_workforce_identity_recovery(text,uuid,boolean)', 'execute')
    or (select enabled from clinical_private.workforce_identity_recovery_release) then
    raise exception using errcode = '55000', message = 'identity_recovery_successor_refused';
  end if;
end
$check$;

commit;
