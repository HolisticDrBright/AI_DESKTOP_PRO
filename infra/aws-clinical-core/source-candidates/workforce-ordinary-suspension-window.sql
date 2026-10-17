-- UNREGISTERED, BLOCKED source candidate (workforce-ordinary-suspension-window). Applied nowhere, registered in no
-- manifest; no route, role or Lambda depends on it. The services keep calling the seven-argument entry until the
-- separate TypeScript release switch (ORDINARY_SUSPENSION_WINDOW_RELEASE) is moved, which is Codex work after review
-- (docs/ordinary-suspension-window-2026-10-17.md).
--
-- Parent: workforce-identity-emergency-revocation.sql, applied over its own parents, so the legacy entry is exactly
-- that successor (clinical_private.set_request_context prosrc SHA-256
-- 3ee98d29830ee366a1c670c236cbf018b710eb7dbbc48d3ee090e7d66c36097b). It therefore keeps the emergency revocation's
-- identity share-lock: a revoked login is refused on its next request whatever this file would otherwise admit. It
-- cannot follow legacy-claims-clinic-status.sql (ruled out by the owner: it ends every session on its next request), and
-- that candidate cannot follow this one: each refuses the other's definition as parent.
-- Rollback: workforce-ordinary-suspension-window-rollback.sql (restores the parent's entry exactly, keeps every
-- recorded status transition).
--
-- The owner's rule for an ORDINARY clinic suspension (not a compromise; a compromise is the emergency revocation): a
-- practitioner session that was already valid when the clinic was suspended may continue only until that token's own
-- expiry; a refreshed or new token does not inherit it; nothing extends it; new consent grants stay blocked (the
-- separate consent-decision candidate). Until this file, the database could not apply that rule: no token time reached
-- it, and a clinic recorded no time it was suspended (ordinary-suspension-continuity.database.test.ts).
--
-- The contract, and nothing more:
--   1. clinical_private.organization_status_transitions: append-only, one row per change of
--      clinical_core.organizations.status, written by a trigger in the changing transaction, with the database's own
--      statement clock. Nothing a caller sends can write it or set its time.
--   2. A second entry, set_request_context(<the same seven values>, _token_issued_at, _token_expires_at, _access): the
--      verified ID token's own `iat` and `exp` (NumericDate seconds) as the API Gateway JWT authorizer verified them,
--      and whether the operation reads or writes. The seven-argument entry is the same call with no evidence.
--   3. The rule, for a workforce clinical_data or identity_link request, after the clinic row is share-locked (so a
--      suspension in flight is waited for, then re-read):
--        active clinic     -> as the parent. With evidence, malformed or expired evidence is refused.
--        suspended clinic  -> admitted only with well-formed evidence of a token issued at least 60 seconds before the
--                             clinic's latest recorded transition, that transition being to 'suspended', and only while
--                             the statement clock is before the token's expiry; only for a declared read; and then the
--                             transaction is made read-only, and statement_timeout and lock_timeout are set to the time
--                             left, so nothing in it can write, and no statement or lock wait runs past the expiry.
--                             A declared write is refused as held (ordinary_suspension_write_held): which new clinical
--                             writes may continue in a suspended clinic is the owner's undecided question.
--        archived clinic, or a suspended clinic without that evidence -> refused (request_context_refused).
--   Workforce consent_management (the retention sweep, erasure recovery, recording cleanup and the practitioner's own
--   consent recording, which the consent-decision candidate governs) and every consumer request are unchanged.
--
-- Why `iat` and not `auth_time`: a Cognito refresh keeps the original auth_time and issues a new iat. The rule is about
-- the token that was valid at the suspension, so it reads iat, and a token refreshed after the suspension has a later
-- iat and is refused.

begin;

do $guard$
declare _fn regprocedure := to_regprocedure('clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)');
  _p record;
begin
  if _fn is null or to_regclass('clinical_private.workforce_identity_revocations') is null
    or to_regprocedure('clinical_private.set_request_context(uuid,uuid,text,text,text,text,text,bigint,bigint,text)') is not null
    or to_regclass('clinical_private.organization_status_transitions') is not null then
    raise exception using errcode = '55000', message = 'ordinary_suspension_window_parent_refused';
  end if;
  select p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as owner, encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') as body
    into _p from pg_proc p where p.oid = _fn;
  if not _p.prosecdef or _p.proconfig is distinct from array['search_path=""'] or _p.owner <> current_user
    or _p.body <> '3ee98d29830ee366a1c670c236cbf018b710eb7dbbc48d3ee090e7d66c36097b' then
    raise exception using errcode = '55000', message = 'ordinary_suspension_window_parent_refused';
  end if;
end
$guard$;

-- 1. The suspension time, recorded by the database. A clinic suspended before this file has no row, so it has no
-- window: its sessions are refused (missing evidence is never guessed).
create table clinical_private.organization_status_transitions (
  id bigint generated always as identity primary key,
  organization_id uuid not null references clinical_core.organizations(id),
  from_status text not null,
  to_status text not null,
  transitioned_at timestamptz not null default clock_timestamp(),
  recorded_by name not null default current_user
);
create index organization_status_transitions_latest on clinical_private.organization_status_transitions (organization_id, id desc);
revoke all on table clinical_private.organization_status_transitions from public;

create function clinical_private.refuse_organization_status_transition_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = '55000', message = 'organization_status_transition_append_only';
end
$$;
revoke all on function clinical_private.refuse_organization_status_transition_change() from public;
create trigger organization_status_transitions_append_only before update or delete on clinical_private.organization_status_transitions
  for each row execute function clinical_private.refuse_organization_status_transition_change();
create trigger organization_status_transitions_no_truncate before truncate on clinical_private.organization_status_transitions
  for each statement execute function clinical_private.refuse_organization_status_transition_change();

create function clinical_private.record_organization_status_transition()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status is distinct from old.status then
    insert into clinical_private.organization_status_transitions(organization_id, from_status, to_status)
      values (new.id, old.status, new.status);
  end if;
  return null;
end
$$;
revoke all on function clinical_private.record_organization_status_transition() from public;
create trigger organization_status_transition_recorded after update of status on clinical_core.organizations
  for each row execute function clinical_private.record_organization_status_transition();

-- 2 and 3. One private admission function; both entries call it.
create function clinical_private.admit_request_context(
  _actor_person_id uuid,
  _organization_id uuid,
  _identity_pool text,
  _identity_subject text,
  _purpose text,
  _environment text,
  _data_classification text,
  _token_issued_at bigint,
  _token_expires_at bigint,
  _access text
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  _evidence boolean := _token_issued_at is not null or _token_expires_at is not null or _access is not null;
  _status text;
  _last record;
  _left bigint;
begin
  if _identity_pool not in ('workforce','consumer')
    or _purpose not in ('identity_link','consent_management','clinical_data')
    or _environment <> 'production-clinical'
    or _data_classification <> 'clinical_phi'
    or not exists (
      select 1 from clinical_core.identities i
      join clinical_core.persons p on p.id = i.person_id
      where i.person_id = _actor_person_id
        and i.identity_pool = _identity_pool
        and i.identity_subject = _identity_subject
        and i.production_bound = true
        and i.status = 'active'
        and p.status = 'active'
        and p.contains_phi = true
    ) then
    raise exception using errcode = '42501', message = 'request_context_refused';
  end if;
  -- The emergency revocation's lock, unchanged: a revoked login is refused here, before any window is considered.
  if _identity_pool = 'workforce' then
    perform 1 from clinical_core.identities i
      where i.person_id = _actor_person_id
        and i.identity_pool = 'workforce'
        and i.identity_subject = _identity_subject
        and i.production_bound = true
        and i.status = 'active'
      for share;
    if not found then
      raise exception using errcode = '42501', message = 'request_context_refused';
    end if;
  end if;
  -- Evidence, when sent, must be whole and well formed: NumericDate seconds, issued before it expires, a lifetime
  -- between 5 minutes and 1 day (Cognito's own ID-token bounds), issued no later than 60 seconds ahead of this clock,
  -- not yet expired, and a declared read or write, whatever the purpose. Anything else is refused, never repaired.
  if _evidence and (_token_issued_at is null or _token_expires_at is null or _access is null
      or _access not in ('read','write')
      or _token_issued_at <= 0 or _token_expires_at <= _token_issued_at
      or _token_expires_at - _token_issued_at not between 300 and 86400
      or to_timestamp(_token_issued_at) > clock_timestamp() + interval '60 seconds'
      or clock_timestamp() >= to_timestamp(_token_expires_at)) then
    raise exception using errcode = '42501', message = 'request_context_refused';
  end if;
  if _identity_pool = 'workforce' and _purpose in ('clinical_data','identity_link') then
    -- Share-locked for the rest of the operation's transaction: a suspension waits for an admitted request to finish,
    -- and a request that waited on a suspension in flight re-reads the committed row here.
    select o.status into _status from clinical_core.organizations o where o.id = _organization_id for share;
    -- The statement clock, read after any wait on that lock: a token that expired while it waited is refused.
    if _evidence and clock_timestamp() >= to_timestamp(_token_expires_at) then
      raise exception using errcode = '42501', message = 'request_context_refused';
    end if;
    if _status is not null and _status <> 'active' then
      if _status <> 'suspended' or not _evidence then
        raise exception using errcode = '42501', message = 'request_context_refused';
      end if;
      select t.to_status, t.transitioned_at into _last
        from clinical_private.organization_status_transitions t
        where t.organization_id = _organization_id order by t.id desc limit 1;
      if _last.to_status is distinct from 'suspended'
        or to_timestamp(_token_issued_at) > _last.transitioned_at - interval '60 seconds' then
        raise exception using errcode = '42501', message = 'request_context_refused';
      end if;
      if _access <> 'read' then
        raise exception using errcode = '42501', message = 'ordinary_suspension_write_held';
      end if;
      _left := floor(extract(epoch from (to_timestamp(_token_expires_at) - clock_timestamp())) * 1000)::bigint;
      if _left < 1 then
        raise exception using errcode = '42501', message = 'request_context_refused';
      end if;
      perform set_config('transaction_read_only', 'on', true);
      perform set_config('statement_timeout', _left::text, true);
      perform set_config('lock_timeout', _left::text, true);
      perform set_config('clinical.claim.admission', 'ordinary_suspension_window', true);
    end if;
  end if;
  perform set_config('clinical.claim.actor_person_id', _actor_person_id::text, true);
  perform set_config('clinical.claim.organization_id', _organization_id::text, true);
  perform set_config('clinical.claim.identity_pool', _identity_pool, true);
  perform set_config('clinical.claim.identity_subject', _identity_subject, true);
  perform set_config('clinical.claim.purpose', _purpose, true);
  perform set_config('clinical.claim.environment', _environment, true);
  perform set_config('clinical.claim.data_classification', _data_classification, true);
end
$$;
revoke all on function clinical_private.admit_request_context(uuid,uuid,text,text,text,text,text,bigint,bigint,text) from public;

create or replace function clinical_private.set_request_context(
  _actor_person_id uuid,
  _organization_id uuid,
  _identity_pool text,
  _identity_subject text,
  _purpose text,
  _environment text,
  _data_classification text
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  -- workforce-ordinary-suspension-window: the same call without token evidence. Unchanged in an active clinic; in a
  -- suspended or archived one a workforce clinical_data or identity_link request is refused.
  perform clinical_private.admit_request_context(_actor_person_id, _organization_id, _identity_pool, _identity_subject,
    _purpose, _environment, _data_classification, null, null, null);
end
$$;

create function clinical_private.set_request_context(
  _actor_person_id uuid,
  _organization_id uuid,
  _identity_pool text,
  _identity_subject text,
  _purpose text,
  _environment text,
  _data_classification text,
  _token_issued_at bigint,
  _token_expires_at bigint,
  _access text
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if _token_issued_at is null or _token_expires_at is null or _access is null then
    raise exception using errcode = '42501', message = 'request_context_refused';
  end if;
  perform clinical_private.admit_request_context(_actor_person_id, _organization_id, _identity_pool, _identity_subject,
    _purpose, _environment, _data_classification, _token_issued_at, _token_expires_at, _access);
end
$$;
revoke all on function clinical_private.set_request_context(uuid,uuid,text,text,text,text,text,bigint,bigint,text) from public;

-- The new entry is callable by exactly the roles that may call the seven-argument one.
do $grants$
declare _role text;
begin
  for _role in select distinct quote_ident(r.rolname) from pg_proc p
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      join pg_roles r on r.oid = a.grantee
      where p.oid = to_regprocedure('clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)')
        and a.privilege_type = 'EXECUTE' and a.grantee <> p.proowner loop
    execute format('grant execute on function clinical_private.set_request_context(uuid,uuid,text,text,text,text,text,bigint,bigint,text) to %s', _role);
  end loop;
end
$grants$;

do $check$
declare _seven regprocedure := to_regprocedure('clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)');
  _ten regprocedure := to_regprocedure('clinical_private.set_request_context(uuid,uuid,text,text,text,text,text,bigint,bigint,text)');
  _admit regprocedure := to_regprocedure('clinical_private.admit_request_context(uuid,uuid,text,text,text,text,text,bigint,bigint,text)');
begin
  if (select encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') from pg_proc where oid = _seven) <> '359837b0d0f46046fae4ea842ddef0b02d9cb284294ac76b30bc442c126370d1'
    or (select encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') from pg_proc where oid = _ten) <> 'f1f07d424d6f1b2da2fbf3a381b3e0eba90a13f24712bacb753ccb4cecf2933d'
    or (select encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') from pg_proc where oid = _admit) <> '8ccbfd1375c1e11ce1205140219fc56ccfbf87da186d905b991e418f94252b32'
    or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.oid in (_seven, _ten, _admit) and a.grantee = 0)
    or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.oid = _admit and a.grantee <> p.proowner)
    or (select array_agg(distinct a.grantee order by a.grantee) from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          where p.oid = _seven and a.privilege_type = 'EXECUTE')
       is distinct from
       (select array_agg(distinct a.grantee order by a.grantee) from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          where p.oid = _ten and a.privilege_type = 'EXECUTE') then
    raise exception using errcode = '55000', message = 'ordinary_suspension_window_successor_refused';
  end if;
end
$check$;

commit;
