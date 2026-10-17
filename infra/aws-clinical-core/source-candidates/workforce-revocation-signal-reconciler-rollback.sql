-- Rollback of the UNREGISTERED, BLOCKED workforce-revocation-signal-reconciler.sql. Applied nowhere.
--
-- Preserving: it removes the reconciler's four functions and its schema (which held only three of them), so the
-- reconciler can no longer claim, record or complete anything. It keeps every row: the sweep log, the lease, and every 'campaign_signal'
-- attempt the reconciler recorded into the provider actions (the parent's append-only table, which the summary keeps
-- reading). It keeps the role too, because Codex may have granted it to a login; the role now executes nothing and
-- holds no table. It changes no parent function and no identity, and deletes nothing from the campaign signal table:
-- a published revocation stays published. The candidate applies again over it, and finds its lease and log intact.
--
-- Roll this back before the campaign-signal successor's rollback. It refuses unless the four functions are exactly
-- the candidate's.

begin;

do $guard$
declare _p record;
begin
  if (select count(*) from pg_proc p where p.oid in (to_regprocedure('clinical_private.workforce_revocation_signal_reconciler_status()'),
      to_regprocedure('clinical_revocation_signal.claim_sweep(uuid,integer)'),
      to_regprocedure('clinical_revocation_signal.record_attempt(uuid,bigint,uuid,uuid,text,text,text)'),
      to_regprocedure('clinical_revocation_signal.complete_sweep(uuid,bigint)'))) <> 4
    or to_regclass('clinical_private.workforce_revocation_signal_sweeps') is null
    or to_regclass('clinical_private.workforce_revocation_signal_reconciler_lease') is null then
    raise exception using errcode = '55000', message = 'revocation_signal_reconciler_rollback_refused';
  end if;
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
      raise exception using errcode = '55000', message = 'revocation_signal_reconciler_rollback_refused';
    end if;
  end loop;
end
$guard$;

drop function clinical_revocation_signal.complete_sweep(uuid,bigint);
drop function clinical_revocation_signal.record_attempt(uuid,bigint,uuid,uuid,text,text,text);
drop function clinical_revocation_signal.claim_sweep(uuid,integer);
drop function clinical_private.workforce_revocation_signal_reconciler_status();
-- Empty now; dropping it refuses if anything else was put there.
drop schema clinical_revocation_signal;

do $check$
begin
  if to_regprocedure('clinical_revocation_signal.claim_sweep(uuid,integer)') is not null
    or to_regprocedure('clinical_revocation_signal.record_attempt(uuid,bigint,uuid,uuid,text,text,text)') is not null
    or to_regprocedure('clinical_revocation_signal.complete_sweep(uuid,bigint)') is not null
    or to_regprocedure('clinical_private.workforce_revocation_signal_reconciler_status()') is not null
    or to_regnamespace('clinical_revocation_signal') is not null
    or has_schema_privilege('clinical_revocation_signal_reconciler', 'clinical_private', 'usage')
    or exists (select 1 from pg_proc p, aclexplode(p.proacl) a
      where a.grantee = (select oid from pg_roles where rolname = 'clinical_revocation_signal_reconciler'))
    or exists (select 1 from pg_class c, aclexplode(c.relacl) a
      where a.grantee = (select oid from pg_roles where rolname = 'clinical_revocation_signal_reconciler'))
    -- The parents are as the candidate found them.
    or (select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') from pg_proc p
      where p.oid = to_regprocedure('clinical_private.workforce_identity_revocation_summary(uuid)')) <> 'da11a53c05619318ccb6e88af3f7c51a9b48f7d3bef3acac34cb2c6ac78f9fe6'
    or (select encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') from pg_proc p
      where p.oid = to_regprocedure('clinical_private.record_workforce_identity_provider_action(text,uuid,uuid,text,text,text)')) <> '8eab347a286520a0619681dc895ea9a216fbb25d4653b4b1e8f47ec7e2b3d458' then
    raise exception using errcode = '55000', message = 'revocation_signal_reconciler_rollback_refused';
  end if;
end
$check$;

commit;
