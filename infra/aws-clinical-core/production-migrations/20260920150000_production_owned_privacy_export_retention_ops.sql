-- Production overlay: export retention as an operated process, not a callable.
--
-- A deletion certificate is a claim about the store at one moment. Settlement
-- (migration 20260920140000) bounds writers admitted before cancellation; it
-- cannot make a later write impossible, so every certified job is reconciled
-- again after the window, and a resource that reappears reopens the cleanup
-- obligation instead of hiding behind the certificate. Cleanup failures are
-- recorded with exponential backoff so one owner's failing job cannot starve
-- the others, and the backlog (counts by retention state, oldest overdue age)
-- is readable by the assigned operator and by the scheduled sweep.
--
-- The scheduled sweep runs under a retention service identity: a workforce
-- identity row named by a reviewed release row (nothing seeded here). Without
-- a live release every sweep function refuses, so the mechanism ships disabled
-- until the operating policy is approved.
alter table clinical_private.owned_privacy_export_jobs
  add column cleanup_attempts integer not null default 0 check(cleanup_attempts>=0),
  add column next_cleanup_at timestamptz,
  add column last_cleanup_error text check(length(last_cleanup_error) between 1 and 120),
  add column reconciled_at timestamptz,
  add column reopened_count integer not null default 0 check(reopened_count>=0),
  add column finished_at timestamptz;
create index owned_privacy_export_jobs_cleanup_due on clinical_private.owned_privacy_export_jobs(next_cleanup_at,created_at) where object_deleted_at is null and status in ('cancelled','failed','expired');
create index owned_privacy_export_jobs_reconcile on clinical_private.owned_privacy_export_jobs(object_deleted_at) where object_deleted_at is not null;

alter table clinical_audit.owned_privacy_export_events drop constraint owned_privacy_export_events_action_check;
alter table clinical_audit.owned_privacy_export_events add constraint owned_privacy_export_events_action_check
  check(action in ('created','records.read','consents.read','job.requested','job.pass','job.completed','job.failed','job.cancelled','job.expired','download.issued','object.deleted',
    'cleanup.deferred','object.reconciled','object.reappeared','retention.sweep'));

-- finished_at is the moment the job stopped being useful to the owner: it anchors the overdue age.
create or replace function clinical_private.expire_owned_privacy_export_job(_j clinical_private.owned_privacy_export_jobs,_operator uuid default null)
returns clinical_private.owned_privacy_export_jobs language plpgsql security definer set search_path='' as $$
declare _out clinical_private.owned_privacy_export_jobs:=_j;
begin
  if _j.expires_at>clock_timestamp() then return _j; end if;
  if _j.status in ('requested','running') then
    update clinical_private.owned_privacy_export_jobs set status='failed',failure_code='deadline_passed',finished_at=coalesce(finished_at,clock_timestamp()),version=version+1,updated_at=clock_timestamp()
      where id=_j.id returning * into _out;
    insert into clinical_audit.owned_privacy_export_events(owner_id,export_id,action,row_count,operator_id) values(_j.owner_id,_j.export_id,'job.failed',0,_operator);
  elsif _j.status='ready' then
    update clinical_private.owned_privacy_export_jobs set status='expired',ready_at=null,finished_at=coalesce(finished_at,_j.expires_at),version=version+1,updated_at=clock_timestamp()
      where id=_j.id returning * into _out;
    insert into clinical_audit.owned_privacy_export_events(owner_id,export_id,action,row_count,operator_id) values(_j.owner_id,_j.export_id,'job.expired',0,_operator);
  end if;
  return _out;
end $$;

create or replace function clinical_core.fail_owned_privacy_export_job(_job uuid,_code text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _j clinical_private.owned_privacy_export_jobs;
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management' or _job is null or _code is null or length(_code) not between 1 and 80 then
    raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  select * into _j from clinical_private.owned_privacy_export_jobs where id=_job and owner_id=_actor for update;
  if not found then raise exception using errcode='42501',message='privacy_export_job_refused'; end if;
  if _j.status in ('failed','cancelled','expired') then return clinical_private.owned_privacy_export_job_view(_j); end if;
  if _j.status='ready' then raise exception using errcode='40001',message='privacy_export_job_state'; end if;
  update clinical_private.owned_privacy_export_jobs set status='failed',failure_code=_code,finished_at=coalesce(finished_at,clock_timestamp()),version=version+1,updated_at=clock_timestamp() where id=_job returning * into _j;
  insert into clinical_audit.owned_privacy_export_events(owner_id,export_id,action,row_count) values(_actor,_j.export_id,'job.failed',0);
  return clinical_private.owned_privacy_export_job_view(_j);
end $$;

create or replace function clinical_core.fail_owned_privacy_export_job(_job uuid,_code text,_version bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _j clinical_private.owned_privacy_export_jobs;
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management' or _job is null or _code is null or length(_code) not between 1 and 80 or _version is null then
    raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  select * into _j from clinical_private.owned_privacy_export_jobs where id=_job and owner_id=_actor for update;
  if not found then raise exception using errcode='42501',message='privacy_export_job_refused'; end if;
  if _j.status in ('failed','cancelled','expired') then return clinical_private.owned_privacy_export_job_view(_j); end if;
  if _j.status='ready' then raise exception using errcode='40001',message='privacy_export_job_state'; end if;
  update clinical_private.owned_privacy_export_jobs set status='failed',failure_code=_code,finished_at=coalesce(finished_at,clock_timestamp()),
    lease_until=case when _j.version=_version and _j.lease_until is not null and _j.lease_until>clock_timestamp() then null else lease_until end,
    version=version+1,updated_at=clock_timestamp() where id=_job returning * into _j;
  insert into clinical_audit.owned_privacy_export_events(owner_id,export_id,action,row_count) values(_actor,_j.export_id,'job.failed',0);
  return clinical_private.owned_privacy_export_job_view(_j);
end $$;

create or replace function clinical_core.cancel_owned_privacy_export_job(_job uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _j clinical_private.owned_privacy_export_jobs;
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management' or _job is null then
    raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  select * into _j from clinical_private.owned_privacy_export_jobs where id=_job and owner_id=_actor for update;
  if not found then raise exception using errcode='42501',message='privacy_export_job_refused'; end if;
  if _j.status in ('cancelled','failed','expired') then return clinical_private.owned_privacy_export_job_view(_j); end if;
  update clinical_private.owned_privacy_export_jobs set status='cancelled',cancelled_at=clock_timestamp(),ready_at=null,finished_at=coalesce(finished_at,clock_timestamp()),version=version+1,updated_at=clock_timestamp()
    where id=_job returning * into _j;
  insert into clinical_audit.owned_privacy_export_events(owner_id,export_id,action,row_count) values(_actor,_j.export_id,'job.cancelled',0);
  return clinical_private.owned_privacy_export_job_view(_j);
end $$;

-- Retention state vocabulary. Export copies are delivery artefacts of records
-- that remain under the owner's retention and any legal hold; the copy itself is
-- never retained under a hold under the current policy (a reviewed decision
-- recorded in docs/personal-storage-privacy-export.md), so 'retained_under_hold'
-- is defined but not produced.
create function clinical_private.privacy_export_retention_state(_j clinical_private.owned_privacy_export_jobs) returns text
language sql immutable set search_path='' as $$
  select case
    when _j.status in ('requested','running') then 'packaging'
    when _j.status='ready' then 'downloadable'
    when _j.object_deleted_at is not null and _j.reconciled_at is not null then 'removal_verified'
    when _j.object_deleted_at is not null then 'removal_recorded'
    else 'cleanup_pending' end
$$;
create or replace function clinical_private.owned_privacy_export_job_view(_j clinical_private.owned_privacy_export_jobs) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('jobId',_j.id,'status',_j.status,'asOf',e.as_of,'recordCount',e.record_count,'consentCount',e.consent_count,
    'requestedAt',_j.created_at,'readyAt',_j.ready_at,'expiresAt',_j.expires_at,
    'section',_j.section,'parts',_j.parts,'bytesWritten',_j.bytes_written,'exportedRecords',_j.exported_records,'exportedConsents',_j.exported_consents,
    'byteLength',case when _j.status='ready' then _j.bytes_written else null end,'objectChecksum',case when _j.status='ready' then _j.object_checksum else null end,
    'failureCode',_j.failure_code,'objectDeleted',_j.object_deleted_at is not null,'version',_j.version,
    'retention',clinical_private.privacy_export_retention_state(_j))
  from clinical_private.owned_privacy_exports e where e.id=_j.export_id
$$;

-- Shared row builders and transitions; authority is checked by the callers below.
create function clinical_private.privacy_export_cleanup_item(_j clinical_private.owned_privacy_export_jobs) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('jobId',_j.id,'ownerId',_j.owner_id,'status',_j.status,'objectKey',_j.object_key,'uploadId',_j.upload_id,
    'objectVersion',_j.object_version,'stagingVersion',_j.staging_version,'bytesWritten',_j.bytes_written,'version',_j.version,
    'settled',clinical_private.privacy_export_settled(_j),'due',_j.next_cleanup_at is null or _j.next_cleanup_at<=clock_timestamp(),'attempts',_j.cleanup_attempts,'reopened',_j.reopened_count,
    'finishedAt',_j.finished_at,'certifiedAt',_j.object_deleted_at)
$$;
create function clinical_private.privacy_export_cleanup_due(_j clinical_private.owned_privacy_export_jobs) returns boolean
language sql stable set search_path='' as $$
  select _j.status in ('cancelled','failed','expired') and _j.object_deleted_at is null and (_j.next_cleanup_at is null or _j.next_cleanup_at<=clock_timestamp())
$$;
-- Reconcile once the settlement window has passed since certification, then daily for thirty days.
create function clinical_private.privacy_export_reconcile_due(_j clinical_private.owned_privacy_export_jobs) returns boolean
language sql stable set search_path='' as $$
  select _j.object_deleted_at is not null and _j.object_deleted_at>clock_timestamp()-interval '30 days'
    and _j.object_deleted_at+clinical_private.privacy_export_settlement()<=clock_timestamp()
    and (_j.reconciled_at is null or _j.reconciled_at<=clock_timestamp()-interval '24 hours')
$$;
create function clinical_private.privacy_export_defer(_j clinical_private.owned_privacy_export_jobs,_error text,_operator uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _out clinical_private.owned_privacy_export_jobs;
begin
  if _error is null or length(_error) not between 1 and 120 then raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  if _j.status not in ('cancelled','failed','expired') or _j.object_deleted_at is not null then raise exception using errcode='40001',message='privacy_export_job_state'; end if;
  update clinical_private.owned_privacy_export_jobs set cleanup_attempts=cleanup_attempts+1,last_cleanup_error=_error,
    next_cleanup_at=clock_timestamp()+least(interval '6 hours',make_interval(mins=>power(2,least(cleanup_attempts,8))::integer)),
    version=version+1,updated_at=clock_timestamp() where id=_j.id returning * into _out;
  insert into clinical_audit.owned_privacy_export_events(owner_id,export_id,action,row_count,operator_id) values(_j.owner_id,_j.export_id,'cleanup.deferred',_out.cleanup_attempts,_operator);
  return jsonb_build_object('jobId',_out.id,'attempts',_out.cleanup_attempts,'nextCleanupAt',_out.next_cleanup_at,'version',_out.version);
end $$;
create function clinical_private.privacy_export_certify(_j clinical_private.owned_privacy_export_jobs,_operator uuid) returns clinical_private.owned_privacy_export_jobs
language plpgsql security definer set search_path='' as $$
declare _out clinical_private.owned_privacy_export_jobs:=_j;
begin
  if _j.status not in ('cancelled','failed','expired') or not clinical_private.privacy_export_settled(_j) then raise exception using errcode='40001',message='privacy_export_job_state'; end if;
  if _j.object_deleted_at is null then
    update clinical_private.owned_privacy_export_jobs set object_deleted_at=clock_timestamp(),upload_id=null,staging_version=null,lease_until=null,
      next_cleanup_at=null,last_cleanup_error=null,version=version+1,updated_at=clock_timestamp() where id=_j.id returning * into _out;
    insert into clinical_audit.owned_privacy_export_events(owner_id,export_id,action,row_count,operator_id) values(_j.owner_id,_j.export_id,'object.deleted',0,_operator);
  end if;
  return _out;
end $$;
-- Reconciliation outcome: nothing found confirms the certificate for another day; anything found reopens the obligation.
create function clinical_private.privacy_export_reconcile(_j clinical_private.owned_privacy_export_jobs,_reappeared boolean,_operator uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _out clinical_private.owned_privacy_export_jobs;
begin
  if _j.object_deleted_at is null or _reappeared is null then raise exception using errcode='40001',message='privacy_export_job_state'; end if;
  if _reappeared then
    update clinical_private.owned_privacy_export_jobs set object_deleted_at=null,reconciled_at=null,reopened_count=reopened_count+1,next_cleanup_at=null,
      version=version+1,updated_at=clock_timestamp() where id=_j.id returning * into _out;
    insert into clinical_audit.owned_privacy_export_events(owner_id,export_id,action,row_count,operator_id) values(_j.owner_id,_j.export_id,'object.reappeared',_out.reopened_count,_operator);
  else
    update clinical_private.owned_privacy_export_jobs set reconciled_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() where id=_j.id returning * into _out;
    insert into clinical_audit.owned_privacy_export_events(owner_id,export_id,action,row_count,operator_id) values(_j.owner_id,_j.export_id,'object.reconciled',0,_operator);
  end if;
  return jsonb_build_object('jobId',_out.id,'retention',clinical_private.privacy_export_retention_state(_out),'reopened',_out.reopened_count,'version',_out.version);
end $$;
-- Backlog over a set of owners (null = every owner): counts by retention state, due/deferred/settling, oldest overdue age.
create function clinical_private.privacy_export_backlog(_owners uuid[]) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'packaging',count(*) filter(where j.status in ('requested','running')),
    'downloadable',count(*) filter(where j.status='ready'),
    'downloadExpired',count(*) filter(where j.status='expired' and j.object_deleted_at is null),
    'cleanupPending',count(*) filter(where clinical_private.privacy_export_cleanup_due(j) and clinical_private.privacy_export_settled(j)),
    'settling',count(*) filter(where j.status in ('cancelled','failed','expired') and j.object_deleted_at is null and not clinical_private.privacy_export_settled(j)),
    'deferred',count(*) filter(where j.status in ('cancelled','failed','expired') and j.object_deleted_at is null and j.next_cleanup_at>clock_timestamp()),
    'removalRecorded',count(*) filter(where j.object_deleted_at is not null and j.reconciled_at is null),
    'removalVerified',count(*) filter(where j.object_deleted_at is not null and j.reconciled_at is not null),
    'reconcileDue',count(*) filter(where clinical_private.privacy_export_reconcile_due(j)),
    'reopened',coalesce(sum(j.reopened_count),0),
    'retainedUnderHold',0,
    'oldestOverdueSeconds',coalesce(max(extract(epoch from clock_timestamp()-coalesce(j.finished_at,j.expires_at))) filter(where j.status in ('cancelled','failed','expired') and j.object_deleted_at is null),0)::bigint,
    'oldestPendingSince',min(coalesce(j.finished_at,j.expires_at)) filter(where j.status in ('cancelled','failed','expired') and j.object_deleted_at is null),
    'measuredAt',clock_timestamp())
  from clinical_private.owned_privacy_export_jobs j where _owners is null or j.owner_id=any(_owners)
$$;

-- Owner authority --------------------------------------------------------------
create or replace function clinical_core.list_owned_privacy_export_cleanup() returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _j clinical_private.owned_privacy_export_jobs;
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management' then
    raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  for _j in select * from clinical_private.owned_privacy_export_jobs where owner_id=_actor and status in ('requested','running','ready') and expires_at<=clock_timestamp() for update loop
    perform clinical_private.expire_owned_privacy_export_job(_j);
  end loop;
  return coalesce((select jsonb_agg(clinical_private.privacy_export_cleanup_item(j)-'ownerId' order by coalesce(j.next_cleanup_at,j.created_at),j.id)
    from clinical_private.owned_privacy_export_jobs j where j.owner_id=_actor and j.status in ('cancelled','failed','expired') and j.object_deleted_at is null),'[]'::jsonb);
end $$;
create function clinical_core.record_owned_privacy_export_cleanup_attempt(_job uuid,_version bigint,_error text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _j clinical_private.owned_privacy_export_jobs;
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management' or _job is null or _version is null then
    raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  select * into _j from clinical_private.owned_privacy_export_jobs where id=_job and owner_id=_actor for update;
  if not found then raise exception using errcode='42501',message='privacy_export_job_refused'; end if;
  if _j.version<>_version then raise exception using errcode='40001',message='privacy_export_job_state'; end if;
  return clinical_private.privacy_export_defer(_j,_error,null);
end $$;
create or replace function clinical_core.record_owned_privacy_export_object_deleted(_job uuid,_version bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _j clinical_private.owned_privacy_export_jobs;
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management' or _job is null or _version is null then
    raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  select * into _j from clinical_private.owned_privacy_export_jobs where id=_job and owner_id=_actor for update;
  if not found then raise exception using errcode='42501',message='privacy_export_job_refused'; end if;
  if _j.version<>_version then raise exception using errcode='40001',message='privacy_export_job_state'; end if;
  return clinical_private.owned_privacy_export_job_view(clinical_private.privacy_export_certify(_j,null));
end $$;
create function clinical_core.list_owned_privacy_export_reconcile() returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor();
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management' then
    raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  return coalesce((select jsonb_agg(clinical_private.privacy_export_cleanup_item(j)-'ownerId' order by j.object_deleted_at,j.id)
    from clinical_private.owned_privacy_export_jobs j where j.owner_id=_actor and clinical_private.privacy_export_reconcile_due(j)),'[]'::jsonb);
end $$;
create function clinical_core.reconcile_owned_privacy_export(_job uuid,_version bigint,_reappeared boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _j clinical_private.owned_privacy_export_jobs;
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management' or _job is null or _version is null or _reappeared is null then
    raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  select * into _j from clinical_private.owned_privacy_export_jobs where id=_job and owner_id=_actor for update;
  if not found then raise exception using errcode='42501',message='privacy_export_job_refused'; end if;
  if _j.version<>_version then raise exception using errcode='40001',message='privacy_export_job_state'; end if;
  return clinical_private.privacy_export_reconcile(_j,_reappeared,null);
end $$;

-- Assigned operator authority ------------------------------------------------------
create or replace function clinical_private.list_privacy_export_cleanup_for_operator(_limit integer default 10) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.privacy_operator(); _j clinical_private.owned_privacy_export_jobs; _owner uuid;
begin
  if _limit is null or _limit not between 1 and 25 or clinical_private.claim('data_classification') is distinct from 'clinical_phi' then
    raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  for _owner in select a.owner_id from clinical_private.owned_privacy_operator_assignments a
      where a.operator_id=_actor and a.revoked_at is null and a.approved_at<=clock_timestamp() and a.expires_at>clock_timestamp() loop
    for _j in select * from clinical_private.owned_privacy_export_jobs where owner_id=_owner and status in ('requested','running','ready') and expires_at<=clock_timestamp() for update loop
      perform clinical_private.expire_owned_privacy_export_job(_j,_actor);
    end loop;
  end loop;
  return coalesce((select jsonb_agg(item) from (select clinical_private.privacy_export_cleanup_item(j) item
    from clinical_private.owned_privacy_export_jobs j join clinical_private.owned_privacy_operator_assignments a on a.owner_id=j.owner_id
    where a.operator_id=_actor and a.revoked_at is null and a.approved_at<=clock_timestamp() and a.expires_at>clock_timestamp()
      and clinical_private.privacy_export_cleanup_due(j) order by coalesce(j.next_cleanup_at,j.created_at),j.id limit _limit) s),'[]'::jsonb);
end $$;
create function clinical_private.lock_privacy_export_for_operator(_owner uuid,_job uuid,_version bigint) returns clinical_private.owned_privacy_export_jobs
language plpgsql security definer set search_path='' as $$
declare _j clinical_private.owned_privacy_export_jobs;
begin
  if _owner is null or _job is null or _version is null then raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  perform clinical_private.privacy_operator_for_owner(_owner);
  select * into _j from clinical_private.owned_privacy_export_jobs where id=_job and owner_id=_owner for update;
  if not found then raise exception using errcode='42501',message='privacy_export_job_refused'; end if;
  if _j.version<>_version then raise exception using errcode='40001',message='privacy_export_job_state'; end if;
  return _j;
end $$;
create or replace function clinical_private.record_privacy_export_object_deleted_by_operator(_owner uuid,_job uuid,_version bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _j clinical_private.owned_privacy_export_jobs:=clinical_private.lock_privacy_export_for_operator(_owner,_job,_version);
begin
  _j:=clinical_private.privacy_export_certify(_j,clinical_private.actor_person_id());
  return jsonb_build_object('jobId',_j.id,'ownerId',_j.owner_id,'status',_j.status,'objectDeleted',_j.object_deleted_at is not null,'version',_j.version);
end $$;
create function clinical_private.defer_privacy_export_cleanup_by_operator(_owner uuid,_job uuid,_version bigint,_error text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _j clinical_private.owned_privacy_export_jobs:=clinical_private.lock_privacy_export_for_operator(_owner,_job,_version);
begin return clinical_private.privacy_export_defer(_j,_error,clinical_private.actor_person_id()); end $$;
create function clinical_private.list_privacy_export_reconcile_for_operator(_limit integer default 10) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.privacy_operator();
begin
  if _limit is null or _limit not between 1 and 25 or clinical_private.claim('data_classification') is distinct from 'clinical_phi' then
    raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  return coalesce((select jsonb_agg(item) from (select clinical_private.privacy_export_cleanup_item(j) item
    from clinical_private.owned_privacy_export_jobs j join clinical_private.owned_privacy_operator_assignments a on a.owner_id=j.owner_id
    where a.operator_id=_actor and a.revoked_at is null and a.approved_at<=clock_timestamp() and a.expires_at>clock_timestamp()
      and clinical_private.privacy_export_reconcile_due(j) order by j.object_deleted_at,j.id limit _limit) s),'[]'::jsonb);
end $$;
create function clinical_private.reconcile_privacy_export_by_operator(_owner uuid,_job uuid,_version bigint,_reappeared boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _j clinical_private.owned_privacy_export_jobs:=clinical_private.lock_privacy_export_for_operator(_owner,_job,_version);
begin return clinical_private.privacy_export_reconcile(_j,_reappeared,clinical_private.actor_person_id()); end $$;
create function clinical_private.privacy_export_backlog_for_operator() returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.privacy_operator();
begin
  if clinical_private.claim('data_classification') is distinct from 'clinical_phi' then raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  return clinical_private.privacy_export_backlog(coalesce((select array_agg(a.owner_id) from clinical_private.owned_privacy_operator_assignments a
    where a.operator_id=_actor and a.revoked_at is null and a.approved_at<=clock_timestamp() and a.expires_at>clock_timestamp()),'{}'::uuid[]))
    ||jsonb_build_object('scope','assigned_owners');
end $$;

-- Retention service authority (scheduled sweep; disabled until a release row exists) ----------
create table clinical_private.privacy_retention_service_releases (
  version text primary key check(length(version) between 1 and 80),
  service_person_id uuid not null references clinical_core.persons(id),
  identity_subject text not null check(identity_subject ~ '^[A-Za-z0-9:_-]{8,128}$'),
  evidence_sha256 text not null check(evidence_sha256 ~ '^[a-f0-9]{64}$'),
  approved_by uuid not null references clinical_core.persons(id),
  approved_at timestamptz not null,
  revoked_at timestamptz,
  check(service_person_id<>approved_by)
);
alter table clinical_private.privacy_retention_service_releases enable row level security;
alter table clinical_private.privacy_retention_service_releases force row level security;
revoke all on clinical_private.privacy_retention_service_releases from public,clinical_core_api;
create function clinical_private.retention_sweep_actor() returns uuid
language plpgsql stable security definer set search_path='' as $$
declare _actor uuid:=clinical_private.actor_person_id();
begin
  if clinical_private.claim('identity_pool') is distinct from 'workforce' or clinical_private.claim('purpose') is distinct from 'consent_management'
    or clinical_private.claim('environment') is distinct from 'production-clinical' or clinical_private.claim('data_classification') is distinct from 'clinical_phi'
    or not exists(select 1 from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
      where i.person_id=_actor and i.identity_pool='workforce' and i.identity_subject=clinical_private.claim('identity_subject')
        and i.status='active' and i.production_bound=true and p.status='active') then
    raise exception using errcode='42501',message='privacy_operator_required'; end if;
  if not exists(select 1 from clinical_private.privacy_retention_service_releases r where r.service_person_id=_actor
      and r.identity_subject=clinical_private.claim('identity_subject') and r.approved_at<=clock_timestamp() and r.revoked_at is null) then
    raise exception using errcode='42501',message='retention_service_release_required'; end if;
  return _actor;
end $$;
create function clinical_private.list_privacy_export_cleanup_for_retention(_limit integer default 25) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.retention_sweep_actor(); _j clinical_private.owned_privacy_export_jobs;
begin
  if _limit is null or _limit not between 1 and 100 then raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  for _j in select * from clinical_private.owned_privacy_export_jobs where status in ('requested','running','ready') and expires_at<=clock_timestamp() order by expires_at limit _limit for update loop
    perform clinical_private.expire_owned_privacy_export_job(_j,_actor);
  end loop;
  return coalesce((select jsonb_agg(item) from (select clinical_private.privacy_export_cleanup_item(j) item from clinical_private.owned_privacy_export_jobs j
    where clinical_private.privacy_export_cleanup_due(j) order by coalesce(j.next_cleanup_at,j.created_at),j.id limit _limit) s),'[]'::jsonb);
end $$;
create function clinical_private.lock_privacy_export_for_retention(_owner uuid,_job uuid,_version bigint) returns clinical_private.owned_privacy_export_jobs
language plpgsql security definer set search_path='' as $$
declare _j clinical_private.owned_privacy_export_jobs;
begin
  if _owner is null or _job is null or _version is null then raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  perform clinical_private.retention_sweep_actor();
  perform pg_advisory_xact_lock(hashtextextended(_owner::text,0));
  select * into _j from clinical_private.owned_privacy_export_jobs where id=_job and owner_id=_owner for update;
  if not found then raise exception using errcode='42501',message='privacy_export_job_refused'; end if;
  if _j.version<>_version then raise exception using errcode='40001',message='privacy_export_job_state'; end if;
  return _j;
end $$;
create function clinical_private.record_privacy_export_object_deleted_by_retention(_owner uuid,_job uuid,_version bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _j clinical_private.owned_privacy_export_jobs:=clinical_private.lock_privacy_export_for_retention(_owner,_job,_version);
begin
  _j:=clinical_private.privacy_export_certify(_j,clinical_private.actor_person_id());
  return jsonb_build_object('jobId',_j.id,'ownerId',_j.owner_id,'status',_j.status,'objectDeleted',_j.object_deleted_at is not null,'version',_j.version);
end $$;
create function clinical_private.defer_privacy_export_cleanup_by_retention(_owner uuid,_job uuid,_version bigint,_error text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _j clinical_private.owned_privacy_export_jobs:=clinical_private.lock_privacy_export_for_retention(_owner,_job,_version);
begin return clinical_private.privacy_export_defer(_j,_error,clinical_private.actor_person_id()); end $$;
create function clinical_private.list_privacy_export_reconcile_for_retention(_limit integer default 25) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform clinical_private.retention_sweep_actor();
  if _limit is null or _limit not between 1 and 100 then raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  return coalesce((select jsonb_agg(item) from (select clinical_private.privacy_export_cleanup_item(j) item from clinical_private.owned_privacy_export_jobs j
    where clinical_private.privacy_export_reconcile_due(j) order by coalesce(j.reconciled_at,j.object_deleted_at),j.id limit _limit) s),'[]'::jsonb);
end $$;
create function clinical_private.reconcile_privacy_export_by_retention(_owner uuid,_job uuid,_version bigint,_reappeared boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _j clinical_private.owned_privacy_export_jobs:=clinical_private.lock_privacy_export_for_retention(_owner,_job,_version);
begin return clinical_private.privacy_export_reconcile(_j,_reappeared,clinical_private.actor_person_id()); end $$;
create function clinical_private.privacy_export_backlog_for_retention() returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform clinical_private.retention_sweep_actor();
  return clinical_private.privacy_export_backlog(null)||jsonb_build_object('scope','all_owners');
end $$;

revoke all on function clinical_private.privacy_export_retention_state(clinical_private.owned_privacy_export_jobs),clinical_private.privacy_export_cleanup_item(clinical_private.owned_privacy_export_jobs),
  clinical_private.privacy_export_cleanup_due(clinical_private.owned_privacy_export_jobs),clinical_private.privacy_export_reconcile_due(clinical_private.owned_privacy_export_jobs),
  clinical_private.privacy_export_defer(clinical_private.owned_privacy_export_jobs,text,uuid),clinical_private.privacy_export_certify(clinical_private.owned_privacy_export_jobs,uuid),
  clinical_private.privacy_export_reconcile(clinical_private.owned_privacy_export_jobs,boolean,uuid),clinical_private.privacy_export_backlog(uuid[]),
  clinical_private.lock_privacy_export_for_operator(uuid,uuid,bigint),clinical_private.lock_privacy_export_for_retention(uuid,uuid,bigint),clinical_private.retention_sweep_actor() from public,clinical_core_api;
revoke all on function clinical_core.record_owned_privacy_export_cleanup_attempt(uuid,bigint,text),clinical_core.list_owned_privacy_export_reconcile(),clinical_core.reconcile_owned_privacy_export(uuid,bigint,boolean),
  clinical_private.defer_privacy_export_cleanup_by_operator(uuid,uuid,bigint,text),clinical_private.list_privacy_export_reconcile_for_operator(integer),clinical_private.reconcile_privacy_export_by_operator(uuid,uuid,bigint,boolean),
  clinical_private.privacy_export_backlog_for_operator(),clinical_private.list_privacy_export_cleanup_for_retention(integer),clinical_private.record_privacy_export_object_deleted_by_retention(uuid,uuid,bigint),
  clinical_private.defer_privacy_export_cleanup_by_retention(uuid,uuid,bigint,text),clinical_private.list_privacy_export_reconcile_for_retention(integer),clinical_private.reconcile_privacy_export_by_retention(uuid,uuid,bigint,boolean),
  clinical_private.privacy_export_backlog_for_retention() from public;
grant execute on function clinical_core.record_owned_privacy_export_cleanup_attempt(uuid,bigint,text),clinical_core.list_owned_privacy_export_reconcile(),clinical_core.reconcile_owned_privacy_export(uuid,bigint,boolean),
  clinical_private.defer_privacy_export_cleanup_by_operator(uuid,uuid,bigint,text),clinical_private.list_privacy_export_reconcile_for_operator(integer),clinical_private.reconcile_privacy_export_by_operator(uuid,uuid,bigint,boolean),
  clinical_private.privacy_export_backlog_for_operator(),clinical_private.list_privacy_export_cleanup_for_retention(integer),clinical_private.record_privacy_export_object_deleted_by_retention(uuid,uuid,bigint),
  clinical_private.defer_privacy_export_cleanup_by_retention(uuid,uuid,bigint,text),clinical_private.list_privacy_export_reconcile_for_retention(integer),clinical_private.reconcile_privacy_export_by_retention(uuid,uuid,bigint,boolean),
  clinical_private.privacy_export_backlog_for_retention() to clinical_core_api;
