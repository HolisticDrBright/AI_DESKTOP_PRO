-- Production overlay: export job recovery and retention that does not depend
-- on the owner returning.
--
-- The independent recheck of migration 20260920110000 reproduced four
-- failures: a lease that raised after marking a job expired (so the rollback
-- left it "running"), an upload id known only after its first part (so the
-- upload created before a failed first part was never recorded), a job stuck
-- at section "done" after the object completed but the database receipt was
-- interrupted, and a cleanup pass that certified deletion when the store
-- refused the abort. This overlay changes the state transitions; the object
-- store reconciliation lives in the API layer, which lists what actually
-- remains under the job's key before anything is certified deleted.
--
-- It also adds the assigned privacy operator's cleanup path: finished and
-- expired jobs of owners the operator is assigned to, including after the
-- owner's account closed, so retention is enforced by an authorized workforce
-- pass rather than by the patient coming back.

alter table clinical_audit.owned_privacy_export_events add column operator_id uuid references clinical_core.persons(id);

-- Expiry is a committed transition, never raised over. Requested and running
-- jobs past their deadline fail with 'deadline_passed'; ready copies past
-- their deadline expire. Both leave the object and any open upload to cleanup.
create function clinical_private.expire_owned_privacy_export_job(_j clinical_private.owned_privacy_export_jobs,_operator uuid default null)
returns clinical_private.owned_privacy_export_jobs language plpgsql security definer set search_path='' as $$
declare _out clinical_private.owned_privacy_export_jobs:=_j;
begin
  if _j.expires_at>clock_timestamp() then return _j; end if;
  if _j.status in ('requested','running') then
    update clinical_private.owned_privacy_export_jobs set status='failed',failure_code='deadline_passed',lease_until=null,version=version+1,updated_at=clock_timestamp()
      where id=_j.id returning * into _out;
    insert into clinical_audit.owned_privacy_export_events(owner_id,export_id,action,row_count,operator_id) values(_j.owner_id,_j.export_id,'job.failed',0,_operator);
  elsif _j.status='ready' then
    update clinical_private.owned_privacy_export_jobs set status='expired',ready_at=null,lease_until=null,version=version+1,updated_at=clock_timestamp()
      where id=_j.id returning * into _out;
    insert into clinical_audit.owned_privacy_export_events(owner_id,export_id,action,row_count,operator_id) values(_j.owner_id,_j.export_id,'job.expired',0,_operator);
  end if;
  return _out;
end $$;

create or replace function clinical_core.get_owned_privacy_export_job(_job uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _j clinical_private.owned_privacy_export_jobs;
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management' or _job is null then
    raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  select * into _j from clinical_private.owned_privacy_export_jobs where id=_job and owner_id=_actor for update;
  if not found then raise exception using errcode='42501',message='privacy_export_job_refused'; end if;
  _j:=clinical_private.expire_owned_privacy_export_job(_j);
  return clinical_private.owned_privacy_export_job_view(_j);
end $$;

-- The lease returns {leased:false} with the committed failed view when the
-- deadline has passed; the caller reports a conflict. Nothing is raised after
-- a state change, so the transition always commits.
create or replace function clinical_core.lease_owned_privacy_export_pass(_job uuid,_lease_seconds integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _j clinical_private.owned_privacy_export_jobs; _export clinical_private.owned_privacy_exports;
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management' or _job is null or _lease_seconds is null or _lease_seconds not between 1 and 60 then
    raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  select * into _j from clinical_private.owned_privacy_export_jobs where id=_job and owner_id=_actor for update;
  if not found then raise exception using errcode='42501',message='privacy_export_job_refused'; end if;
  if _j.status not in ('requested','running') then raise exception using errcode='40001',message='privacy_export_job_state'; end if;
  if _j.expires_at<=clock_timestamp() then
    _j:=clinical_private.expire_owned_privacy_export_job(_j);
    return jsonb_build_object('leased',false)||clinical_private.owned_privacy_export_job_view(_j);
  end if;
  if _j.lease_until is not null and _j.lease_until>clock_timestamp() then raise exception using errcode='40001',message='privacy_export_job_busy'; end if;
  update clinical_private.owned_privacy_export_jobs set status='running',lease_until=clock_timestamp()+make_interval(secs=>_lease_seconds),version=version+1,updated_at=clock_timestamp()
    where id=_job returning * into _j;
  select * into _export from clinical_private.owned_privacy_exports where id=_j.export_id;
  return jsonb_build_object('leased',true,'jobId',_j.id,'exportId',_export.id,'asOf',_export.as_of,'recordCount',_export.record_count,'consentCount',_export.consent_count,
    'objectKey',_j.object_key,'uploadId',_j.upload_id,'section',_j.section,'cursor',_j.cursor,'parts',_j.parts,'partSha256s',_j.part_sha256s,'partEtags',_j.part_etags,
    'bytesWritten',_j.bytes_written,'exportedRecords',_j.exported_records,'exportedConsents',_j.exported_consents,'stagingVersion',_j.staging_version,
    'version',_j.version,'leaseUntil',_j.lease_until);
end $$;

-- The upload id is recorded the moment the store returns it, under the same
-- lease, before any part is sent. Returns the new version the pass must use.
create function clinical_core.record_owned_privacy_export_upload(_job uuid,_version bigint,_upload_id text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _j clinical_private.owned_privacy_export_jobs;
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management' or _job is null or _version is null
    or _upload_id is null or length(_upload_id) not between 1 and 1024 or _upload_id='null' then
    raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  select * into _j from clinical_private.owned_privacy_export_jobs where id=_job and owner_id=_actor for update;
  if not found then raise exception using errcode='42501',message='privacy_export_job_refused'; end if;
  if _j.status<>'running' or _j.version<>_version or _j.lease_until is null or _j.lease_until<=clock_timestamp() or _j.section='done'
    or (_j.upload_id is not null and _j.upload_id<>_upload_id) then
    raise exception using errcode='40001',message='privacy_export_job_state'; end if;
  update clinical_private.owned_privacy_export_jobs set upload_id=_upload_id,version=version+1,updated_at=clock_timestamp() where id=_job returning * into _j;
  return jsonb_build_object('jobId',_j.id,'version',_j.version,'uploadId',_j.upload_id);
end $$;

-- Completion no longer requires the upload id: after the store completed the
-- object but the receipt was interrupted, the recovering pass finds the exact
-- version under the job's key and records it. The recorded parts and counts
-- must still be complete.
create or replace function clinical_core.complete_owned_privacy_export_job(_job uuid,_version bigint,_object_version text,_object_checksum text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _j clinical_private.owned_privacy_export_jobs; _export clinical_private.owned_privacy_exports;
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management' or _job is null or _version is null
    or _object_version is null or length(_object_version) not between 1 and 1024 or _object_version='null'
    or _object_checksum is null or length(_object_checksum) not between 1 and 128 then
    raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  select * into _j from clinical_private.owned_privacy_export_jobs where id=_job and owner_id=_actor for update;
  if not found then raise exception using errcode='42501',message='privacy_export_job_refused'; end if;
  select * into _export from clinical_private.owned_privacy_exports where id=_j.export_id;
  if _j.status<>'running' or _j.version<>_version or _j.section<>'done' or _j.parts<1 or _j.expires_at<=clock_timestamp()
    or _j.exported_records<>_export.record_count or _j.exported_consents<>_export.consent_count then
    raise exception using errcode='40001',message='privacy_export_job_state'; end if;
  update clinical_private.owned_privacy_export_jobs set status='ready',ready_at=clock_timestamp(),object_version=_object_version,object_checksum=_object_checksum,
    staging_version=null,upload_id=null,lease_until=null,version=version+1,updated_at=clock_timestamp() where id=_job returning * into _j;
  insert into clinical_audit.owned_privacy_export_events(owner_id,export_id,action,row_count) values(_actor,_j.export_id,'job.completed',least(_j.exported_records+_j.exported_consents,2147483647)::integer);
  return clinical_private.owned_privacy_export_job_view(_j);
end $$;

-- The owner's cleanup list: every finished job whose objects are not yet
-- certified removed, after committing any deadline transitions with their
-- audit rows. Unfinished jobs past their deadline are listed as failed.
create or replace function clinical_core.list_owned_privacy_export_cleanup() returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _j clinical_private.owned_privacy_export_jobs;
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management' then
    raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  for _j in select * from clinical_private.owned_privacy_export_jobs where owner_id=_actor and status in ('requested','running','ready') and expires_at<=clock_timestamp() for update loop
    perform clinical_private.expire_owned_privacy_export_job(_j);
  end loop;
  return coalesce((select jsonb_agg(jsonb_build_object('jobId',j.id,'status',j.status,'objectKey',j.object_key,'uploadId',j.upload_id,
      'objectVersion',j.object_version,'stagingVersion',j.staging_version,'bytesWritten',j.bytes_written,'version',j.version) order by j.created_at,j.id)
    from clinical_private.owned_privacy_export_jobs j where j.owner_id=_actor and j.status in ('cancelled','failed','expired') and j.object_deleted_at is null),'[]'::jsonb);
end $$;

-- Assigned-operator retention pass. Lists the cleanup-eligible jobs of owners
-- this operator holds a live assignment for, oldest first, bounded; the
-- owner's account state is irrelevant (closed accounts are included), and no
-- row content is exposed: only keys, versions and ids.
create function clinical_private.list_privacy_export_cleanup_for_operator(_limit integer default 10) returns jsonb
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
  return coalesce((select jsonb_agg(item) from (select jsonb_build_object('jobId',j.id,'ownerId',j.owner_id,'status',j.status,'objectKey',j.object_key,'uploadId',j.upload_id,
      'objectVersion',j.object_version,'stagingVersion',j.staging_version,'bytesWritten',j.bytes_written,'version',j.version) item
    from clinical_private.owned_privacy_export_jobs j join clinical_private.owned_privacy_operator_assignments a on a.owner_id=j.owner_id
    where a.operator_id=_actor and a.revoked_at is null and a.approved_at<=clock_timestamp() and a.expires_at>clock_timestamp()
      and j.status in ('cancelled','failed','expired') and j.object_deleted_at is null order by j.created_at,j.id limit _limit) s),'[]'::jsonb);
end $$;

-- Certification by the assigned operator after the store showed nothing
-- remains under the job's key. Same owner lock as every other fulfillment step.
create function clinical_private.record_privacy_export_object_deleted_by_operator(_owner uuid,_job uuid,_version bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid; _j clinical_private.owned_privacy_export_jobs;
begin
  if _owner is null or _job is null or _version is null then raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  _actor:=clinical_private.privacy_operator_for_owner(_owner);
  select * into _j from clinical_private.owned_privacy_export_jobs where id=_job and owner_id=_owner for update;
  if not found then raise exception using errcode='42501',message='privacy_export_job_refused'; end if;
  if _j.status not in ('cancelled','failed','expired') or _j.version<>_version then raise exception using errcode='40001',message='privacy_export_job_state'; end if;
  if _j.object_deleted_at is null then
    update clinical_private.owned_privacy_export_jobs set object_deleted_at=clock_timestamp(),upload_id=null,staging_version=null,version=version+1,updated_at=clock_timestamp() where id=_job returning * into _j;
    insert into clinical_audit.owned_privacy_export_events(owner_id,export_id,action,row_count,operator_id) values(_owner,_j.export_id,'object.deleted',0,_actor);
  end if;
  return jsonb_build_object('jobId',_j.id,'ownerId',_j.owner_id,'status',_j.status,'objectDeleted',_j.object_deleted_at is not null,'version',_j.version);
end $$;

revoke all on function clinical_private.expire_owned_privacy_export_job(clinical_private.owned_privacy_export_jobs,uuid) from public,clinical_core_api;
revoke all on function clinical_core.record_owned_privacy_export_upload(uuid,bigint,text),
  clinical_private.list_privacy_export_cleanup_for_operator(integer),clinical_private.record_privacy_export_object_deleted_by_operator(uuid,uuid,bigint) from public;
grant execute on function clinical_core.record_owned_privacy_export_upload(uuid,bigint,text),
  clinical_private.list_privacy_export_cleanup_for_operator(integer),clinical_private.record_privacy_export_object_deleted_by_operator(uuid,uuid,bigint) to clinical_core_api;
