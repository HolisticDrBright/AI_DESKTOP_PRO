-- Production overlay: large personal-storage exports as owner-scoped jobs.
--
-- The inline export (migration 20260916010000) refuses accounts above 5,000
-- versions or 16 MiB because the phone assembles the file in memory. A job
-- packages the same two sections server-side, in bounded passes that run only
-- while the owner is authenticated and asking for progress: each pass reads a
-- bounded number of pages under the owner's identity, uploads one encrypted
-- object part, and records the cursor, so the work survives interruption and
-- never needs a background service identity (the production security model has
-- consumer and workforce identities only; adding a service identity is a
-- reviewed decision, not a side effect of an export feature). Delivery is a
-- short-lived signed link for the exact object version, issued only to a
-- freshly authenticated owner; the object expires and is deleted afterwards.
-- Nothing here is a complete account export; coverage is the inline export's.
create table clinical_private.owned_privacy_export_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references clinical_core.persons(id),
  request_id uuid not null,
  export_id uuid not null references clinical_private.owned_privacy_exports(id),
  status text not null default 'requested' check(status in ('requested','running','ready','failed','cancelled','expired')),
  object_key text not null unique check(length(object_key) between 1 and 512),
  upload_id text check(length(upload_id) between 1 and 1024),
  section text not null default 'records' check(section in ('records','consents','done')),
  cursor jsonb,
  parts integer not null default 0 check(parts between 0 and 10000),
  part_sha256s jsonb not null default '[]'::jsonb,
  part_etags jsonb not null default '[]'::jsonb,
  bytes_written bigint not null default 0 check(bytes_written>=0),
  exported_records bigint not null default 0 check(exported_records>=0),
  exported_consents bigint not null default 0 check(exported_consents>=0),
  staging_version text check(length(staging_version) between 1 and 1024),
  object_version text check(length(object_version) between 1 and 1024),
  object_checksum text check(length(object_checksum) between 1 and 128),
  version bigint not null default 1 check(version>0),
  lease_until timestamptz,
  ready_at timestamptz,
  expires_at timestamptz not null,
  failure_code text check(length(failure_code) between 1 and 80),
  cancelled_at timestamptz,
  object_deleted_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(owner_id,request_id),
  check((status='ready')=(ready_at is not null)),
  check((status='failed')=(failure_code is not null)),
  check((status='cancelled')=(cancelled_at is not null))
);
create index owned_privacy_export_jobs_owner on clinical_private.owned_privacy_export_jobs(owner_id,created_at,id);
create unique index owned_privacy_export_jobs_one_open on clinical_private.owned_privacy_export_jobs(owner_id) where status in ('requested','running','ready');
alter table clinical_private.owned_privacy_export_jobs enable row level security;
alter table clinical_private.owned_privacy_export_jobs force row level security;
revoke all on clinical_private.owned_privacy_export_jobs from public,clinical_core_api;

alter table clinical_audit.owned_privacy_export_events drop constraint owned_privacy_export_events_action_check;
alter table clinical_audit.owned_privacy_export_events add constraint owned_privacy_export_events_action_check
  check(action in ('created','records.read','consents.read','job.requested','job.pass','job.completed','job.failed','job.cancelled','job.expired','download.issued','object.deleted'));

create function clinical_private.owned_privacy_export_job_view(_j clinical_private.owned_privacy_export_jobs) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('jobId',_j.id,'status',_j.status,'asOf',e.as_of,'recordCount',e.record_count,'consentCount',e.consent_count,
    'requestedAt',_j.created_at,'readyAt',_j.ready_at,'expiresAt',_j.expires_at,
    'section',_j.section,'parts',_j.parts,'bytesWritten',_j.bytes_written,'exportedRecords',_j.exported_records,'exportedConsents',_j.exported_consents,
    'byteLength',case when _j.status='ready' then _j.bytes_written else null end,'objectChecksum',case when _j.status='ready' then _j.object_checksum else null end,
    'failureCode',_j.failure_code,'objectDeleted',_j.object_deleted_at is not null,'version',_j.version)
  from clinical_private.owned_privacy_exports e where e.id=_j.export_id
$$;

-- Owner requests a job. One open job per owner; retries with the same request
-- id replay. The snapshot cut-off is taken now and stays readable for the job's
-- whole life, so a job never mixes rows written after its cut-off.
create function clinical_core.request_owned_privacy_export_job(_request_id uuid,_object_prefix text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _job clinical_private.owned_privacy_export_jobs; _export clinical_private.owned_privacy_exports;
  _as_of timestamptz; _records bigint; _consents bigint;
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management' or _request_id is null
    or _object_prefix is null or _object_prefix!~'^personal-exports/[a-f0-9]{64}/$' then
    raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  perform pg_advisory_xact_lock(hashtextextended(_actor::text,0));
  select * into _job from clinical_private.owned_privacy_export_jobs where owner_id=_actor and request_id=_request_id;
  if found then
    select * into _export from clinical_private.owned_privacy_exports where id=_job.export_id;
    return clinical_private.owned_privacy_export_job_view(_job)||jsonb_build_object('replayed',true);
  end if;
  if exists(select 1 from clinical_private.owned_privacy_export_jobs where owner_id=_actor and status in ('requested','running','ready')) then
    raise exception using errcode='40001',message='privacy_export_conflict'; end if;
  -- At most one new job per owner per hour.
  if exists(select 1 from clinical_private.owned_privacy_export_jobs where owner_id=_actor and created_at>clock_timestamp()-interval '1 hour') then
    raise exception using errcode='40001',message='privacy_export_conflict'; end if;
  _as_of:=clock_timestamp();
  select count(*) into _records from clinical_core.owned_consumer_record_versions where owner_id=_actor and received_at<=_as_of;
  select count(*) into _consents from clinical_core.consumer_storage_consents where owner_id=_actor and recorded_at<=_as_of;
  insert into clinical_private.owned_privacy_exports(owner_id,request_id,as_of,expires_at,record_count,consent_count)
    values(_actor,_request_id,_as_of,_as_of+interval '48 hours',_records,_consents) returning * into _export;
  insert into clinical_private.owned_privacy_export_jobs(owner_id,request_id,export_id,object_key,expires_at)
    values(_actor,_request_id,_export.id,_object_prefix||gen_random_uuid()::text||'.json',_as_of+interval '48 hours') returning * into _job;
  insert into clinical_audit.owned_privacy_export_events(owner_id,export_id,action,row_count) values(_actor,_export.id,'job.requested',0);
  return clinical_private.owned_privacy_export_job_view(_job)||jsonb_build_object('replayed',false);
end $$;

create function clinical_core.get_owned_privacy_export_job(_job uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _j clinical_private.owned_privacy_export_jobs; _export clinical_private.owned_privacy_exports;
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management' or _job is null then
    raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  select * into _j from clinical_private.owned_privacy_export_jobs where id=_job and owner_id=_actor for update;
  if not found then raise exception using errcode='42501',message='privacy_export_job_refused'; end if;
  -- A ready copy past its expiry is reported expired; the object is removed by the owner's next cleanup pass.
  if _j.status='ready' and _j.expires_at<=clock_timestamp() then
    update clinical_private.owned_privacy_export_jobs set status='expired',ready_at=null,version=version+1,updated_at=clock_timestamp() where id=_job returning * into _j;
    insert into clinical_audit.owned_privacy_export_events(owner_id,export_id,action,row_count) values(_actor,_j.export_id,'job.expired',0);
  end if;
  return clinical_private.owned_privacy_export_job_view(_j);
end $$;

-- One bounded pass. Returns the work state (cursor, upload, staging) under a
-- short lease so two concurrent polls from the owner's devices cannot both write.
create function clinical_core.lease_owned_privacy_export_pass(_job uuid,_lease_seconds integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _j clinical_private.owned_privacy_export_jobs; _export clinical_private.owned_privacy_exports;
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management' or _job is null or _lease_seconds is null or _lease_seconds not between 1 and 60 then
    raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  select * into _j from clinical_private.owned_privacy_export_jobs where id=_job and owner_id=_actor for update;
  if not found then raise exception using errcode='42501',message='privacy_export_job_refused'; end if;
  if _j.status not in ('requested','running') then raise exception using errcode='40001',message='privacy_export_job_state'; end if;
  if _j.lease_until is not null and _j.lease_until>clock_timestamp() then raise exception using errcode='40001',message='privacy_export_job_busy'; end if;
  if _j.expires_at<=clock_timestamp() then
    update clinical_private.owned_privacy_export_jobs set status='failed',failure_code='deadline_passed',lease_until=null,version=version+1,updated_at=clock_timestamp() where id=_job;
    insert into clinical_audit.owned_privacy_export_events(owner_id,export_id,action,row_count) values(_actor,_j.export_id,'job.failed',0);
    raise exception using errcode='40001',message='privacy_export_job_state'; end if;
  update clinical_private.owned_privacy_export_jobs set status='running',lease_until=clock_timestamp()+make_interval(secs=>_lease_seconds),version=version+1,updated_at=clock_timestamp()
    where id=_job returning * into _j;
  select * into _export from clinical_private.owned_privacy_exports where id=_j.export_id;
  return jsonb_build_object('jobId',_j.id,'exportId',_export.id,'asOf',_export.as_of,'recordCount',_export.record_count,'consentCount',_export.consent_count,
    'objectKey',_j.object_key,'uploadId',_j.upload_id,'section',_j.section,'cursor',_j.cursor,'parts',_j.parts,'partSha256s',_j.part_sha256s,'partEtags',_j.part_etags,
    'bytesWritten',_j.bytes_written,'exportedRecords',_j.exported_records,'exportedConsents',_j.exported_consents,'stagingVersion',_j.staging_version,
    'version',_j.version,'leaseUntil',_j.lease_until);
end $$;

-- Progress after a pass: the upload id once created, one more part or a new
-- staging object, and the cursor. The version must be the leased one.
create function clinical_core.record_owned_privacy_export_pass(_job uuid,_version bigint,_upload_id text,_part_sha256 text,_part_etag text,_part_bytes bigint,
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
  update clinical_private.owned_privacy_export_jobs set upload_id=coalesce(_upload_id,upload_id),
    parts=parts+case when _part_sha256 is null then 0 else 1 end,
    part_sha256s=case when _part_sha256 is null then part_sha256s else part_sha256s||to_jsonb(_part_sha256) end,
    part_etags=case when _part_etag is null then part_etags else part_etags||to_jsonb(_part_etag) end,
    bytes_written=bytes_written+coalesce(_part_bytes,0),staging_version=_staging_version,section=_section,cursor=_cursor,
    exported_records=_exported_records,exported_consents=_exported_consents,lease_until=null,version=version+1,updated_at=clock_timestamp()
    where id=_job returning * into _j;
  insert into clinical_audit.owned_privacy_export_events(owner_id,export_id,action,row_count) values(_actor,_j.export_id,'job.pass',0);
  return clinical_private.owned_privacy_export_job_view(_j);
end $$;

-- The multipart upload completed: the exact object version and S3 checksum are recorded and the copy becomes downloadable.
create function clinical_core.complete_owned_privacy_export_job(_job uuid,_version bigint,_object_version text,_object_checksum text) returns jsonb
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
  if _j.status<>'running' or _j.version<>_version or _j.section<>'done' or _j.parts<1 or _j.upload_id is null
    or _j.exported_records<>_export.record_count or _j.exported_consents<>_export.consent_count then
    raise exception using errcode='40001',message='privacy_export_job_state'; end if;
  update clinical_private.owned_privacy_export_jobs set status='ready',ready_at=clock_timestamp(),object_version=_object_version,object_checksum=_object_checksum,
    staging_version=null,upload_id=null,lease_until=null,version=version+1,updated_at=clock_timestamp() where id=_job returning * into _j;
  insert into clinical_audit.owned_privacy_export_events(owner_id,export_id,action,row_count) values(_actor,_j.export_id,'job.completed',least(_j.exported_records+_j.exported_consents,2147483647)::integer);
  return clinical_private.owned_privacy_export_job_view(_j);
end $$;

create function clinical_core.fail_owned_privacy_export_job(_job uuid,_code text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _j clinical_private.owned_privacy_export_jobs;
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management' or _job is null or _code is null or length(_code) not between 1 and 80 then
    raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  select * into _j from clinical_private.owned_privacy_export_jobs where id=_job and owner_id=_actor for update;
  if not found then raise exception using errcode='42501',message='privacy_export_job_refused'; end if;
  if _j.status in ('failed','cancelled','expired') then return clinical_private.owned_privacy_export_job_view(_j); end if;
  if _j.status='ready' then raise exception using errcode='40001',message='privacy_export_job_state'; end if;
  update clinical_private.owned_privacy_export_jobs set status='failed',failure_code=_code,lease_until=null,version=version+1,updated_at=clock_timestamp() where id=_job returning * into _j;
  insert into clinical_audit.owned_privacy_export_events(owner_id,export_id,action,row_count) values(_actor,_j.export_id,'job.failed',0);
  return clinical_private.owned_privacy_export_job_view(_j);
end $$;

create function clinical_core.cancel_owned_privacy_export_job(_job uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _j clinical_private.owned_privacy_export_jobs;
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management' or _job is null then
    raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  select * into _j from clinical_private.owned_privacy_export_jobs where id=_job and owner_id=_actor for update;
  if not found then raise exception using errcode='42501',message='privacy_export_job_refused'; end if;
  if _j.status in ('cancelled','failed','expired') then return clinical_private.owned_privacy_export_job_view(_j); end if;
  update clinical_private.owned_privacy_export_jobs set status='cancelled',cancelled_at=clock_timestamp(),ready_at=null,lease_until=null,version=version+1,updated_at=clock_timestamp()
    where id=_job returning * into _j;
  insert into clinical_audit.owned_privacy_export_events(owner_id,export_id,action,row_count) values(_actor,_j.export_id,'job.cancelled',0);
  return clinical_private.owned_privacy_export_job_view(_j);
end $$;

-- Coordinates for a short-lived signed download of the exact ready version.
-- The API layer additionally requires a fresh sign-in before calling this.
create function clinical_core.issue_owned_privacy_export_download(_job uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _j clinical_private.owned_privacy_export_jobs;
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management' or _job is null then
    raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  select * into _j from clinical_private.owned_privacy_export_jobs where id=_job and owner_id=_actor for update;
  if not found then raise exception using errcode='42501',message='privacy_export_job_refused'; end if;
  if _j.status<>'ready' or _j.expires_at<=clock_timestamp() or _j.object_version is null or _j.object_deleted_at is not null then
    raise exception using errcode='40001',message='privacy_export_job_state'; end if;
  insert into clinical_audit.owned_privacy_export_events(owner_id,export_id,action,row_count) values(_actor,_j.export_id,'download.issued',0);
  return jsonb_build_object('jobId',_j.id,'objectKey',_j.object_key,'objectVersion',_j.object_version,'objectChecksum',_j.object_checksum,
    'byteLength',_j.bytes_written,'expiresAt',_j.expires_at);
end $$;

-- The owner's own finished jobs whose objects or open uploads still need
-- removal: cancelled, failed and expired jobs, and ready jobs past expiry.
create function clinical_core.list_owned_privacy_export_cleanup() returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor();
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management' then
    raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  update clinical_private.owned_privacy_export_jobs set status='expired',ready_at=null,version=version+1,updated_at=clock_timestamp()
    where owner_id=_actor and status='ready' and expires_at<=clock_timestamp();
  return coalesce((select jsonb_agg(jsonb_build_object('jobId',j.id,'status',j.status,'objectKey',j.object_key,'uploadId',j.upload_id,
      'objectVersion',j.object_version,'stagingVersion',j.staging_version,'version',j.version) order by j.created_at,j.id)
    from clinical_private.owned_privacy_export_jobs j where j.owner_id=_actor and j.status in ('cancelled','failed','expired') and j.object_deleted_at is null),'[]'::jsonb);
end $$;

create function clinical_core.record_owned_privacy_export_object_deleted(_job uuid,_version bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _j clinical_private.owned_privacy_export_jobs;
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management' or _job is null or _version is null then
    raise exception using errcode='22023',message='privacy_export_request_invalid'; end if;
  select * into _j from clinical_private.owned_privacy_export_jobs where id=_job and owner_id=_actor for update;
  if not found then raise exception using errcode='42501',message='privacy_export_job_refused'; end if;
  if _j.status not in ('cancelled','failed','expired') or _j.version<>_version then raise exception using errcode='40001',message='privacy_export_job_state'; end if;
  if _j.object_deleted_at is null then
    update clinical_private.owned_privacy_export_jobs set object_deleted_at=clock_timestamp(),upload_id=null,staging_version=null,version=version+1,updated_at=clock_timestamp() where id=_job returning * into _j;
    insert into clinical_audit.owned_privacy_export_events(owner_id,export_id,action,row_count) values(_actor,_j.export_id,'object.deleted',0);
  end if;
  return clinical_private.owned_privacy_export_job_view(_j);
end $$;

revoke all on function clinical_private.owned_privacy_export_job_view(clinical_private.owned_privacy_export_jobs) from public,clinical_core_api;
revoke all on function clinical_core.request_owned_privacy_export_job(uuid,text),clinical_core.get_owned_privacy_export_job(uuid),
  clinical_core.lease_owned_privacy_export_pass(uuid,integer),clinical_core.record_owned_privacy_export_pass(uuid,bigint,text,text,text,bigint,text,text,jsonb,bigint,bigint),
  clinical_core.complete_owned_privacy_export_job(uuid,bigint,text,text),clinical_core.fail_owned_privacy_export_job(uuid,text),
  clinical_core.cancel_owned_privacy_export_job(uuid),clinical_core.issue_owned_privacy_export_download(uuid),
  clinical_core.list_owned_privacy_export_cleanup(),clinical_core.record_owned_privacy_export_object_deleted(uuid,bigint) from public;
grant execute on function clinical_core.request_owned_privacy_export_job(uuid,text),clinical_core.get_owned_privacy_export_job(uuid),
  clinical_core.lease_owned_privacy_export_pass(uuid,integer),clinical_core.record_owned_privacy_export_pass(uuid,bigint,text,text,text,bigint,text,text,jsonb,bigint,bigint),
  clinical_core.complete_owned_privacy_export_job(uuid,bigint,text,text),clinical_core.fail_owned_privacy_export_job(uuid,text),
  clinical_core.cancel_owned_privacy_export_job(uuid),clinical_core.issue_owned_privacy_export_download(uuid),
  clinical_core.list_owned_privacy_export_cleanup(),clinical_core.record_owned_privacy_export_object_deleted(uuid,bigint) to clinical_core_api;
