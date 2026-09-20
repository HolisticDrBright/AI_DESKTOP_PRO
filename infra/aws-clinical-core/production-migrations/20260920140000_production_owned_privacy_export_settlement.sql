-- Production overlay: export job settlement before deletion certification.
--
-- The migration 95 recheck reproduced a race: a pass had leased a job and
-- started a storage request; the owner cancelled and ran cleanup while both
-- listings were still empty; the job was certified deleted; then the storage
-- request landed and its upload had no cleanup obligation left. Two empty
-- listings do not prove that an admitted writer cannot finish afterwards.
--
-- The lease is the record of an admitted writer. From here on nothing erases
-- it except the pass that finished its own storage work: cancellation, failure
-- and expiry keep lease_until, a recorded pass clears it only when no
-- completion step remains, and completion clears it. A finished job is listed
-- for cleanup only once its last lease is at least the settlement window old,
-- which bounds the time a request aborted client-side at lease expiry could
-- still land in the store. The API layer aborts every storage request at the
-- lease boundary so the window is measured from a known point.
create function clinical_private.privacy_export_settlement() returns interval
language sql immutable set search_path='' as $$ select interval '60 seconds' $$;

create or replace function clinical_private.expire_owned_privacy_export_job(_j clinical_private.owned_privacy_export_jobs,_operator uuid default null)
returns clinical_private.owned_privacy_export_jobs language plpgsql security definer set search_path='' as $$
declare _out clinical_private.owned_privacy_export_jobs:=_j;
begin
  if _j.expires_at>clock_timestamp() then return _j; end if;
  if _j.status in ('requested','running') then
    update clinical_private.owned_privacy_export_jobs set status='failed',failure_code='deadline_passed',version=version+1,updated_at=clock_timestamp()
      where id=_j.id returning * into _out;
    insert into clinical_audit.owned_privacy_export_events(owner_id,export_id,action,row_count,operator_id) values(_j.owner_id,_j.export_id,'job.failed',0,_operator);
  elsif _j.status='ready' then
    update clinical_private.owned_privacy_export_jobs set status='expired',ready_at=null,version=version+1,updated_at=clock_timestamp()
      where id=_j.id returning * into _out;
    insert into clinical_audit.owned_privacy_export_events(owner_id,export_id,action,row_count,operator_id) values(_j.owner_id,_j.export_id,'job.expired',0,_operator);
  end if;
  return _out;
end $$;

create or replace function clinical_core.record_owned_privacy_export_pass(_job uuid,_version bigint,_upload_id text,_part_sha256 text,_part_etag text,_part_bytes bigint,
  _staging_version text,_section text,_cursor jsonb,_exported_records bigint,_exported_consents bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _j clinical_private.owned_privacy_export_jobs;
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management' or _job is null or _version is null
    or _section is null or _section not in ('records','consents','done')
    or (_part_sha256 is not null and _part_sha256!~'^[a-f0-9]{64}$') or ((_part_sha256 is null)<>(_part_bytes is null)) or ((_part_sha256 is null)<>(_part_etag is null))
    or (_part_etag is not null and length(_part_etag) not between 1 and 256)
    or (_part_bytes is not null and _part_bytes not between 1 and 5368709120)
    or (_staging_version is not null and (length(_staging_version) not between 1 and 1024 or _staging_version='null'))
    or (_upload_id is not null and length(_upload_id) not between 1 and 1024)
    or _exported_records is null or _exported_records<0 or _exported_consents is null or _exported_consents<0 then
    raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  select * into _j from clinical_private.owned_privacy_export_jobs where id=_job and owner_id=_actor for update;
  if not found then raise exception using errcode='42501',message='privacy_export_job_refused'; end if;
  if _j.status<>'running' or _j.version<>_version or _j.lease_until is null or _j.lease_until<=clock_timestamp() then
    raise exception using errcode='40001',message='privacy_export_job_state'; end if;
  if (_j.upload_id is not null and _upload_id is distinct from _j.upload_id) or (_part_sha256 is not null and _upload_id is null)
    or _exported_records<_j.exported_records or _exported_consents<_j.exported_consents
    or (_j.section='consents' and _section='records') or (_j.section='done') then
    raise exception using errcode='40001',message='privacy_export_job_state'; end if;
  -- The lease is released only when this pass has no storage step left; a pass that recorded the last part still completes the upload.
  update clinical_private.owned_privacy_export_jobs set upload_id=coalesce(_upload_id,upload_id),
    parts=parts+case when _part_sha256 is null then 0 else 1 end,
    part_sha256s=case when _part_sha256 is null then part_sha256s else part_sha256s||to_jsonb(_part_sha256) end,
    part_etags=case when _part_etag is null then part_etags else part_etags||to_jsonb(_part_etag) end,
    bytes_written=bytes_written+coalesce(_part_bytes,0),staging_version=_staging_version,section=_section,cursor=_cursor,
    exported_records=_exported_records,exported_consents=_exported_consents,
    lease_until=case when _section='done' then lease_until else null end,version=version+1,updated_at=clock_timestamp()
    where id=_job returning * into _j;
  insert into clinical_audit.owned_privacy_export_events(owner_id,export_id,action,row_count) values(_actor,_j.export_id,'job.pass',0);
  return clinical_private.owned_privacy_export_job_view(_j);
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
  update clinical_private.owned_privacy_export_jobs set status='failed',failure_code=_code,version=version+1,updated_at=clock_timestamp() where id=_job returning * into _j;
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
  update clinical_private.owned_privacy_export_jobs set status='cancelled',cancelled_at=clock_timestamp(),ready_at=null,version=version+1,updated_at=clock_timestamp()
    where id=_job returning * into _j;
  insert into clinical_audit.owned_privacy_export_events(owner_id,export_id,action,row_count) values(_actor,_j.export_id,'job.cancelled',0);
  return clinical_private.owned_privacy_export_job_view(_j);
end $$;

-- The leaseholder itself may fail the job and release its lease: it knows its own
-- storage work is over. Any other caller (a later poll, an operator) keeps it.
create function clinical_core.fail_owned_privacy_export_job(_job uuid,_code text,_version bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _j clinical_private.owned_privacy_export_jobs;
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management' or _job is null or _code is null or length(_code) not between 1 and 80 or _version is null then
    raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  select * into _j from clinical_private.owned_privacy_export_jobs where id=_job and owner_id=_actor for update;
  if not found then raise exception using errcode='42501',message='privacy_export_job_refused'; end if;
  if _j.status in ('failed','cancelled','expired') then return clinical_private.owned_privacy_export_job_view(_j); end if;
  if _j.status='ready' then raise exception using errcode='40001',message='privacy_export_job_state'; end if;
  update clinical_private.owned_privacy_export_jobs set status='failed',failure_code=_code,
    lease_until=case when _j.version=_version and _j.lease_until is not null and _j.lease_until>clock_timestamp() then null else lease_until end,
    version=version+1,updated_at=clock_timestamp() where id=_job returning * into _j;
  insert into clinical_audit.owned_privacy_export_events(owner_id,export_id,action,row_count) values(_actor,_j.export_id,'job.failed',0);
  return clinical_private.owned_privacy_export_job_view(_j);
end $$;

-- Settled: no admitted writer can still land. Unsettled finished jobs are reported so callers can show honest pending state.
create function clinical_private.privacy_export_settled(_j clinical_private.owned_privacy_export_jobs) returns boolean
language sql stable set search_path='' as $$
  select _j.lease_until is null or _j.lease_until+clinical_private.privacy_export_settlement()<=clock_timestamp()
$$;

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
      'objectVersion',j.object_version,'stagingVersion',j.staging_version,'bytesWritten',j.bytes_written,'version',j.version,
      'settled',clinical_private.privacy_export_settled(j)) order by j.created_at,j.id)
    from clinical_private.owned_privacy_export_jobs j where j.owner_id=_actor and j.status in ('cancelled','failed','expired') and j.object_deleted_at is null),'[]'::jsonb);
end $$;

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
  return coalesce((select jsonb_agg(item) from (select jsonb_build_object('jobId',j.id,'ownerId',j.owner_id,'status',j.status,'objectKey',j.object_key,'uploadId',j.upload_id,
      'objectVersion',j.object_version,'stagingVersion',j.staging_version,'bytesWritten',j.bytes_written,'version',j.version,
      'settled',clinical_private.privacy_export_settled(j)) item
    from clinical_private.owned_privacy_export_jobs j join clinical_private.owned_privacy_operator_assignments a on a.owner_id=j.owner_id
    where a.operator_id=_actor and a.revoked_at is null and a.approved_at<=clock_timestamp() and a.expires_at>clock_timestamp()
      and j.status in ('cancelled','failed','expired') and j.object_deleted_at is null order by j.created_at,j.id limit _limit) s),'[]'::jsonb);
end $$;

-- Certification refuses an unsettled job even if a caller skipped the listing's flag.
create or replace function clinical_core.record_owned_privacy_export_object_deleted(_job uuid,_version bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _j clinical_private.owned_privacy_export_jobs;
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management' or _job is null or _version is null then
    raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  select * into _j from clinical_private.owned_privacy_export_jobs where id=_job and owner_id=_actor for update;
  if not found then raise exception using errcode='42501',message='privacy_export_job_refused'; end if;
  if _j.status not in ('cancelled','failed','expired') or _j.version<>_version or not clinical_private.privacy_export_settled(_j) then
    raise exception using errcode='40001',message='privacy_export_job_state'; end if;
  if _j.object_deleted_at is null then
    update clinical_private.owned_privacy_export_jobs set object_deleted_at=clock_timestamp(),upload_id=null,staging_version=null,lease_until=null,version=version+1,updated_at=clock_timestamp() where id=_job returning * into _j;
    insert into clinical_audit.owned_privacy_export_events(owner_id,export_id,action,row_count) values(_actor,_j.export_id,'object.deleted',0);
  end if;
  return clinical_private.owned_privacy_export_job_view(_j);
end $$;

create or replace function clinical_private.record_privacy_export_object_deleted_by_operator(_owner uuid,_job uuid,_version bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid; _j clinical_private.owned_privacy_export_jobs;
begin
  if _owner is null or _job is null or _version is null then raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  _actor:=clinical_private.privacy_operator_for_owner(_owner);
  select * into _j from clinical_private.owned_privacy_export_jobs where id=_job and owner_id=_owner for update;
  if not found then raise exception using errcode='42501',message='privacy_export_job_refused'; end if;
  if _j.status not in ('cancelled','failed','expired') or _j.version<>_version or not clinical_private.privacy_export_settled(_j) then
    raise exception using errcode='40001',message='privacy_export_job_state'; end if;
  if _j.object_deleted_at is null then
    update clinical_private.owned_privacy_export_jobs set object_deleted_at=clock_timestamp(),upload_id=null,staging_version=null,lease_until=null,version=version+1,updated_at=clock_timestamp() where id=_job returning * into _j;
    insert into clinical_audit.owned_privacy_export_events(owner_id,export_id,action,row_count,operator_id) values(_owner,_j.export_id,'object.deleted',0,_actor);
  end if;
  return jsonb_build_object('jobId',_j.id,'ownerId',_j.owner_id,'status',_j.status,'objectDeleted',_j.object_deleted_at is not null,'version',_j.version);
end $$;

revoke all on function clinical_private.privacy_export_settlement(),clinical_private.privacy_export_settled(clinical_private.owned_privacy_export_jobs) from public,clinical_core_api;
revoke all on function clinical_core.fail_owned_privacy_export_job(uuid,text,bigint) from public;
grant execute on function clinical_core.fail_owned_privacy_export_job(uuid,text,bigint) to clinical_core_api;
