-- UNREGISTERED, BLOCKED source candidate (workforce-revocation-signal-reconciler). Applied nowhere, registered in no
-- manifest; no login, Lambda, schedule or grant outside this file uses it. Registration and execution are Codex work
-- after review (docs/revocation-signal-reconciler-2026-10-17.md). Nothing here is switched on by being applied: the
-- reconciler that calls it is BLOCKED in source, and its template deploys nothing.
--
-- Parents, in this order, each as written: workforce-identity-emergency-revocation.sql, then
-- workforce-revocation-campaign-signal.sql (workforce_identity_revocation_summary prosrc SHA-256
-- da11a53c05619318ccb6e88af3f7c51a9b48f7d3bef3acac34cb2c6ac78f9fe6, record_workforce_identity_provider_action prosrc SHA-256
-- 8eab347a286520a0619681dc895ea9a216fbb25d4653b4b1e8f47ec7e2b3d458, and the step check admitting 'campaign_signal'). It changes
-- neither, nor set_request_context.
-- Rollback: workforce-revocation-signal-reconciler-rollback.sql. Roll it back before the campaign-signal successor's.
--
-- Why. A revocation whose campaign signal did not publish stays on the operator's work list, and only an operator's
-- reconciliation retries it. Until someone does, the campaign engine keeps admitting the revoked login's old token.
-- This file lets a scheduled reconciler retry the publication with no operator involved, from the revocation records
-- that already exist, and nothing else:
--   * clinical_revocation_signal_reconciler: a NOLOGIN, NOINHERIT role. Codex grants it to the reconciler's own
--     database login. It executes exactly the three entry points below, in a schema of their own
--     (clinical_revocation_signal), and reads or writes no table itself. It is never granted USAGE on clinical_private:
--     PUBLIC holds EXECUTE on functions there (some SECURITY DEFINER) that any role with that USAGE could call.
--   * the sweep log: one append-only row per granted lease. Every attempt the reconciler records names its sweep in
--     recorded_by, so a reconciler record is always distinguishable from an operator's.
--   * the lease: one row, one holder at a time, 60 seconds long, and a generation that fences a holder whose lease
--     lapsed: its records are refused once another sweep holds the lease.
--   * claim: takes the lease and returns the due list, read from the existing records: every revocation whose latest
--     'campaign_signal' attempt did not succeed, or that has none, never attempted first, then least recently
--     attempted. The attempt records are the durable cursor: a sweep that dies part way leaves the items it attempted
--     at the back and the rest first in line, and a new revocation is never queued behind a stuck one.
--   * record: one 'campaign_signal' attempt, into the existing append-only provider actions, by its own idempotency
--     key, only for the subject the revocation recorded, and only while the caller holds the lease.
--   * complete: releases the lease, and records when the last sweep finished.
-- These functions never read whether an operator is active, and require none. Nothing here proposes, decides,
-- approves, confirms, disputes, releases or restores a revocation, or changes an identity, and nothing here deletes.

begin;

do $guard$
declare _p record;
begin
  if to_regclass('clinical_private.workforce_identity_provider_actions') is null
    or to_regclass('clinical_private.workforce_identity_revocations') is null
    or to_regclass('clinical_private.workforce_platform_operators') is null
    or (select pg_get_userbyid(relowner) from pg_class where oid = to_regclass('clinical_private.workforce_identity_provider_actions')) <> current_user
    or (select pg_get_constraintdef(c.oid) from pg_constraint c
      where c.conrelid = to_regclass('clinical_private.workforce_identity_provider_actions')
        and c.conname = 'workforce_identity_provider_actions_step_check') is distinct from 'CHECK ((step = ANY (ARRAY[''disable_user''::text, ''global_sign_out''::text, ''campaign_signal''::text])))'
    or to_regprocedure('clinical_private.workforce_identity_revocation_summary(uuid)') is null
    or to_regprocedure('clinical_private.record_workforce_identity_provider_action(text,uuid,uuid,text,text,text)') is null
    or to_regprocedure('clinical_private.workforce_identity_revocation_append_only()') is null then
    raise exception using errcode = '55000', message = 'revocation_signal_reconciler_parent_refused';
  end if;
  for _p in select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') as body,
      p.oid = to_regprocedure('clinical_private.workforce_identity_revocation_summary(uuid)') as is_summary
    from pg_proc p where p.oid in (to_regprocedure('clinical_private.workforce_identity_revocation_summary(uuid)'),
      to_regprocedure('clinical_private.record_workforce_identity_provider_action(text,uuid,uuid,text,text,text)')) loop
    if _p.body <> (case when _p.is_summary then 'da11a53c05619318ccb6e88af3f7c51a9b48f7d3bef3acac34cb2c6ac78f9fe6' else '8eab347a286520a0619681dc895ea9a216fbb25d4653b4b1e8f47ec7e2b3d458' end) then
      raise exception using errcode = '55000', message = 'revocation_signal_reconciler_parent_refused';
    end if;
  end loop;
  -- Applied again over its own rollback: the role, the sweep log and the lease are this file's, and kept.
  if exists (select 1 from pg_roles where rolname = 'clinical_revocation_signal_reconciler'
      and (rolcanlogin or rolinherit or rolsuper or rolcreaterole or rolcreatedb or rolreplication or rolbypassrls))
    or exists (select 1 from pg_auth_members m join pg_roles r on r.oid = m.member where r.rolname = 'clinical_revocation_signal_reconciler')
    -- Its schema is created here and dropped by the rollback: one that already exists is someone else's.
    or to_regnamespace('clinical_revocation_signal') is not null
    or (to_regclass('clinical_private.workforce_revocation_signal_sweeps') is not null
      and obj_description(to_regclass('clinical_private.workforce_revocation_signal_sweeps'), 'pg_class') is distinct from 'workforce-revocation-signal-reconciler/1')
    or (to_regclass('clinical_private.workforce_revocation_signal_reconciler_lease') is not null
      and obj_description(to_regclass('clinical_private.workforce_revocation_signal_reconciler_lease'), 'pg_class') is distinct from 'workforce-revocation-signal-reconciler/1') then
    raise exception using errcode = '55000', message = 'revocation_signal_reconciler_parent_refused';
  end if;
end
$guard$;

do $role$
begin
  if not exists (select 1 from pg_roles where rolname = 'clinical_revocation_signal_reconciler') then
    create role clinical_revocation_signal_reconciler nologin noinherit;
  end if;
end
$role$;
-- Its own schema, holding only its three entry points. It is never granted USAGE on clinical_private, where PUBLIC
-- holds EXECUTE on functions the reconciler has no business calling.
create schema if not exists clinical_revocation_signal;
revoke all on schema clinical_revocation_signal from public;
grant usage on schema clinical_revocation_signal to clinical_revocation_signal_reconciler;

do $tables$
begin
  if to_regclass('clinical_private.workforce_revocation_signal_sweeps') is null then
    create table clinical_private.workforce_revocation_signal_sweeps (
      sweep_id uuid primary key check (sweep_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
      generation bigint not null unique check (generation > 0),
      started_at timestamptz not null default clock_timestamp()
    );
    comment on table clinical_private.workforce_revocation_signal_sweeps is 'workforce-revocation-signal-reconciler/1';
    create trigger workforce_revocation_signal_sweeps_append_only before update or delete on clinical_private.workforce_revocation_signal_sweeps
      for each row execute function clinical_private.workforce_identity_revocation_append_only();
    create trigger workforce_revocation_signal_sweeps_no_truncate before truncate on clinical_private.workforce_revocation_signal_sweeps
      for each statement execute function clinical_private.workforce_identity_revocation_append_only();
    alter table clinical_private.workforce_revocation_signal_sweeps enable row level security;
  end if;
  if to_regclass('clinical_private.workforce_revocation_signal_reconciler_lease') is null then
    create table clinical_private.workforce_revocation_signal_reconciler_lease (
      singleton boolean primary key default true check (singleton),
      generation bigint not null default 0 check (generation >= 0),
      holder uuid references clinical_private.workforce_revocation_signal_sweeps(sweep_id),
      lease_until timestamptz,
      last_completed_sweep uuid references clinical_private.workforce_revocation_signal_sweeps(sweep_id),
      last_completed_at timestamptz,
      check ((holder is null) = (lease_until is null)),
      check ((last_completed_sweep is null) = (last_completed_at is null))
    );
    comment on table clinical_private.workforce_revocation_signal_reconciler_lease is 'workforce-revocation-signal-reconciler/1';
    alter table clinical_private.workforce_revocation_signal_reconciler_lease enable row level security;
    insert into clinical_private.workforce_revocation_signal_reconciler_lease(singleton) values (true);
  end if;
end
$tables$;
revoke all on clinical_private.workforce_revocation_signal_sweeps, clinical_private.workforce_revocation_signal_reconciler_lease
  from public, clinical_core_api, clinical_workforce_application, clinical_workforce_operator, clinical_revocation_signal_reconciler;

-- What every sweep reports: how many revocations are still unpublished, the oldest of them, and when a sweep last
-- finished. The owner's alone; claim and complete return it.
create or replace function clinical_private.workforce_revocation_signal_reconciler_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare _unpublished bigint; _oldest timestamptz; _l clinical_private.workforce_revocation_signal_reconciler_lease%rowtype;
begin
  select count(*), min(r.revoked_at) into _unpublished, _oldest
    from clinical_private.workforce_identity_revocations r
    where coalesce((select a.outcome from clinical_private.workforce_identity_provider_actions a
      where a.revocation_id = r.id and a.step = 'campaign_signal' order by a.recorded_at desc, a.id desc limit 1), 'none') <> 'succeeded';
  select * into _l from clinical_private.workforce_revocation_signal_reconciler_lease where singleton;
  return jsonb_build_object('unpublished', _unpublished, 'oldestUnpublishedAt', _oldest, 'lastCompletedAt', _l.last_completed_at);
end $$;

create or replace function clinical_revocation_signal.claim_sweep(_sweep_id uuid, _limit integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare _l clinical_private.workforce_revocation_signal_reconciler_lease%rowtype;
  _generation bigint;
  _until timestamptz;
begin
  if _sweep_id is null or _limit is null or _limit < 1 or _limit > 200 then
    raise exception using errcode = '22023', message = 'workforce_revocation_signal_sweep_invalid';
  end if;
  -- A sweep id is never an operator's subject, so a reconciler record can never read as an operator's.
  if exists (select 1 from clinical_private.workforce_platform_operators o where lower(o.operator_subject) = lower(_sweep_id::text)) then
    raise exception using errcode = '42501', message = 'workforce_revocation_signal_sweep_refused';
  end if;
  select * into _l from clinical_private.workforce_revocation_signal_reconciler_lease where singleton for update;
  if _l.holder = _sweep_id and _l.lease_until > clock_timestamp() then
    -- The holder asking again (its first answer was lost): the same generation, the lease renewed.
    _generation := _l.generation;
    _until := clock_timestamp() + interval '60 seconds';
    update clinical_private.workforce_revocation_signal_reconciler_lease set lease_until = _until where singleton;
  elsif _l.holder is not null and _l.lease_until > clock_timestamp() then
    return jsonb_build_object('granted', false, 'reason', 'lease_held', 'leaseUntil', _l.lease_until)
      || clinical_private.workforce_revocation_signal_reconciler_status();
  elsif exists (select 1 from clinical_private.workforce_revocation_signal_sweeps s where s.sweep_id = _sweep_id) then
    -- A sweep that completed, or whose lease lapsed, is never granted again: a retry is a new sweep.
    return jsonb_build_object('granted', false, 'reason', 'sweep_id_used', 'leaseUntil', null)
      || clinical_private.workforce_revocation_signal_reconciler_status();
  else
    _generation := _l.generation + 1;
    _until := clock_timestamp() + interval '60 seconds';
    insert into clinical_private.workforce_revocation_signal_sweeps(sweep_id, generation) values (_sweep_id, _generation);
    update clinical_private.workforce_revocation_signal_reconciler_lease
      set generation = _generation, holder = _sweep_id, lease_until = _until where singleton;
  end if;
  return jsonb_build_object('granted', true, 'generation', _generation, 'leaseUntil', _until,
    'due', coalesce((select jsonb_agg(jsonb_build_object('revocationId', d.id, 'subject', d.identity_subject, 'revokedAt', d.revoked_at,
        'attempts', d.attempts, 'lastAttemptAt', d.last_attempt_at) order by d.last_attempt_at asc nulls first, d.revoked_at, d.id)
      from (select r.id, r.identity_subject, r.revoked_at,
          (select count(*) from clinical_private.workforce_identity_provider_actions a
            where a.revocation_id = r.id and a.step = 'campaign_signal' and a.outcome = 'failed') as attempts,
          (select max(a.recorded_at) from clinical_private.workforce_identity_provider_actions a
            where a.revocation_id = r.id and a.step = 'campaign_signal') as last_attempt_at
        from clinical_private.workforce_identity_revocations r
        where coalesce((select a.outcome from clinical_private.workforce_identity_provider_actions a
          where a.revocation_id = r.id and a.step = 'campaign_signal' order by a.recorded_at desc, a.id desc limit 1), 'none') <> 'succeeded'
        order by last_attempt_at asc nulls first, r.revoked_at, r.id
        limit _limit) d), '[]'::jsonb))
    || clinical_private.workforce_revocation_signal_reconciler_status();
end $$;

create or replace function clinical_revocation_signal.record_attempt(
  _sweep_id uuid, _generation bigint, _action_id uuid, _revocation_id uuid, _identity_subject text, _outcome text, _failure_code text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare _l clinical_private.workforce_revocation_signal_reconciler_lease%rowtype;
  _r clinical_private.workforce_identity_revocations%rowtype;
  _a clinical_private.workforce_identity_provider_actions%rowtype;
begin
  if _sweep_id is null or _generation is null or _generation < 1 or _action_id is null or _revocation_id is null
    or _identity_subject is null or _identity_subject !~ '^[A-Za-z0-9:_-]{8,128}$'
    or _outcome is null or _outcome not in ('succeeded','failed')
    or (_outcome = 'failed') <> (_failure_code is not null)
    or (_failure_code is not null and _failure_code not in ('not_found','throttled','unavailable','access_denied','timeout','unknown')) then
    raise exception using errcode = '22023', message = 'workforce_revocation_signal_attempt_invalid';
  end if;
  -- Held for share until this records: a sweep taking the lease over waits, and then this holder is fenced.
  select * into _l from clinical_private.workforce_revocation_signal_reconciler_lease where singleton for share;
  if _l.holder is distinct from _sweep_id or _l.generation <> _generation or _l.lease_until <= clock_timestamp() then
    return jsonb_build_object('result', 'lease_lost');
  end if;
  select * into _r from clinical_private.workforce_identity_revocations where id = _revocation_id;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  -- Only the subject this revocation recorded: a publication for any other login confirms nothing about this one.
  if _r.identity_subject <> _identity_subject then
    return jsonb_build_object('result', 'subject_mismatch');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('workforce-identity-provider-action/' || _action_id::text, 0));
  select * into _a from clinical_private.workforce_identity_provider_actions where action_id = _action_id;
  if found then
    if _a.revocation_id <> _revocation_id or _a.step <> 'campaign_signal' or _a.outcome <> _outcome
      or _a.failure_code is distinct from _failure_code or _a.recorded_by <> _sweep_id::text then
      raise exception using errcode = '23505', message = 'workforce_identity_revocation_conflict';
    end if;
    return jsonb_build_object('result', 'recorded', 'duplicate', true);
  end if;
  insert into clinical_private.workforce_identity_provider_actions(action_id, revocation_id, step, outcome, failure_code, recorded_by)
    values (_action_id, _revocation_id, 'campaign_signal', _outcome, _failure_code, _sweep_id::text);
  return jsonb_build_object('result', 'recorded', 'duplicate', false);
end $$;

create or replace function clinical_revocation_signal.complete_sweep(_sweep_id uuid, _generation bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare _l clinical_private.workforce_revocation_signal_reconciler_lease%rowtype;
begin
  if _sweep_id is null or _generation is null or _generation < 1 then
    raise exception using errcode = '22023', message = 'workforce_revocation_signal_sweep_invalid';
  end if;
  select * into _l from clinical_private.workforce_revocation_signal_reconciler_lease where singleton for update;
  if _l.holder is distinct from _sweep_id or _l.generation <> _generation then
    return jsonb_build_object('completed', false) || clinical_private.workforce_revocation_signal_reconciler_status();
  end if;
  update clinical_private.workforce_revocation_signal_reconciler_lease
    set holder = null, lease_until = null, last_completed_sweep = _sweep_id, last_completed_at = clock_timestamp() where singleton;
  return jsonb_build_object('completed', true) || clinical_private.workforce_revocation_signal_reconciler_status();
end $$;

revoke all on function clinical_private.workforce_revocation_signal_reconciler_status() from public;
revoke all on function clinical_revocation_signal.claim_sweep(uuid,integer) from public;
revoke all on function clinical_revocation_signal.record_attempt(uuid,bigint,uuid,uuid,text,text,text) from public;
revoke all on function clinical_revocation_signal.complete_sweep(uuid,bigint) from public;
grant execute on function clinical_revocation_signal.claim_sweep(uuid,integer) to clinical_revocation_signal_reconciler;
grant execute on function clinical_revocation_signal.record_attempt(uuid,bigint,uuid,uuid,text,text,text) to clinical_revocation_signal_reconciler;
grant execute on function clinical_revocation_signal.complete_sweep(uuid,bigint) to clinical_revocation_signal_reconciler;

do $check$
declare _p record;
begin
  for _p in select p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as owner,
      encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') as body
    from pg_proc p where p.oid in (to_regprocedure('clinical_private.workforce_revocation_signal_reconciler_status()'),
      to_regprocedure('clinical_revocation_signal.claim_sweep(uuid,integer)'),
      to_regprocedure('clinical_revocation_signal.record_attempt(uuid,bigint,uuid,uuid,text,text,text)'),
      to_regprocedure('clinical_revocation_signal.complete_sweep(uuid,bigint)')) loop
    if not _p.prosecdef or _p.proconfig is distinct from array['search_path=""'] or _p.owner <> current_user
      or _p.body <> (case _p.proname
        when 'workforce_revocation_signal_reconciler_status' then '970fe12e450bb4c52ebfa9d4c3e0dbaefee845e7abd0fe7609f4c4c07742cb7d'
        when 'claim_sweep' then 'eb495344faa066add3e45114a820e03212575518bdacdf0e99b6f6282e98b276'
        when 'record_attempt' then '705ec0b0722bbab43ac4d9b17d2eb8f63d466e948941faabfb46e2ca0b852dd9'
        when 'complete_sweep' then 'c5494ed3275da42cbeb2c6503ea034e78a1d9d733ab2854311aa6df46b489857' end) then
      raise exception using errcode = '55000', message = 'revocation_signal_reconciler_successor_refused';
    end if;
  end loop;
  if (select count(*) from pg_proc p where p.oid in (to_regprocedure('clinical_private.workforce_revocation_signal_reconciler_status()'),
      to_regprocedure('clinical_revocation_signal.claim_sweep(uuid,integer)'),
      to_regprocedure('clinical_revocation_signal.record_attempt(uuid,bigint,uuid,uuid,text,text,text)'),
      to_regprocedure('clinical_revocation_signal.complete_sweep(uuid,bigint)'))) <> 4
    -- The reconciler is granted exactly the three functions and no table; no other role is granted them.
    or (select count(*) from pg_proc p, aclexplode(p.proacl) a
      where a.grantee = (select oid from pg_roles where rolname = 'clinical_revocation_signal_reconciler')) <> 3
    or exists (select 1 from pg_class c, aclexplode(c.relacl) a
      where a.grantee = (select oid from pg_roles where rolname = 'clinical_revocation_signal_reconciler'))
    or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.oid in (to_regprocedure('clinical_private.workforce_revocation_signal_reconciler_status()'),
        to_regprocedure('clinical_revocation_signal.claim_sweep(uuid,integer)'),
        to_regprocedure('clinical_revocation_signal.record_attempt(uuid,bigint,uuid,uuid,text,text,text)'),
        to_regprocedure('clinical_revocation_signal.complete_sweep(uuid,bigint)'))
        and a.grantee <> p.proowner and a.grantee <> (select oid from pg_roles where rolname = 'clinical_revocation_signal_reconciler'))
    or has_function_privilege('clinical_revocation_signal_reconciler', 'clinical_private.workforce_revocation_signal_reconciler_status()', 'execute')
    -- Its schema holds the three and nothing else, and only it may use that schema; it may use no clinical schema.
    or (select count(*) from pg_proc p where p.pronamespace = to_regnamespace('clinical_revocation_signal')) <> 3
    or exists (select 1 from pg_class c where c.relnamespace = to_regnamespace('clinical_revocation_signal'))
    or exists (select 1 from pg_namespace n, aclexplode(n.nspacl) a where n.oid = to_regnamespace('clinical_revocation_signal')
      and a.grantee <> n.nspowner and a.grantee <> (select oid from pg_roles where rolname = 'clinical_revocation_signal_reconciler'))
    or has_schema_privilege('clinical_revocation_signal_reconciler', 'clinical_private', 'usage')
    or has_schema_privilege('clinical_revocation_signal_reconciler', 'clinical_core', 'usage')
    -- The parents are as they were.
    or (select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') from pg_proc p
      where p.oid = to_regprocedure('clinical_private.workforce_identity_revocation_summary(uuid)')) <> 'da11a53c05619318ccb6e88af3f7c51a9b48f7d3bef3acac34cb2c6ac78f9fe6'
    or (select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') from pg_proc p
      where p.oid = to_regprocedure('clinical_private.record_workforce_identity_provider_action(text,uuid,uuid,text,text,text)')) <> '8eab347a286520a0619681dc895ea9a216fbb25d4653b4b1e8f47ec7e2b3d458' then
    raise exception using errcode = '55000', message = 'revocation_signal_reconciler_successor_refused';
  end if;
end
$check$;

commit;
