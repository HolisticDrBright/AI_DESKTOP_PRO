-- Encounter transcription authority. No provider approval, job, transcript or
-- note is seeded. A finished recording may be transcribed only under every
-- participant's current transcription consent, an approved provider release
-- for the organization, no legal hold and no cleanup intent. Transcripts are
-- immutable versions; corrections append. Nothing here starts a provider job,
-- reads audio, writes a clinical note or deletes anything.
create table clinical_private.recording_transcription_releases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  configuration jsonb not null check(jsonb_typeof(configuration)='object'),
  configuration_sha256 text not null check(configuration_sha256 ~ '^[a-f0-9]{64}$'),
  qualification_sha256 text not null check(qualification_sha256 ~ '^[a-f0-9]{64}$'),
  approved_by text not null check(length(btrim(approved_by)) between 1 and 200),
  approved_at timestamptz not null,
  expires_at timestamptz not null,
  retired_at timestamptz,
  check(expires_at>approved_at)
);
create table clinical_private.recording_transcription_jobs (
  id uuid primary key default gen_random_uuid(),
  recording_id uuid not null references clinical_private.encounter_captures(id),
  release_id uuid not null references clinical_private.recording_transcription_releases(id),
  command_id uuid not null,
  requested_by uuid not null references clinical_core.persons(id),
  participant_ids uuid[] not null check(cardinality(participant_ids)>0),
  transcription_grant_ids uuid[] not null check(cardinality(transcription_grant_ids)>0),
  segment_count integer not null check(segment_count between 1 and 4096),
  inventory_sha256 text not null check(inventory_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null default 'requested' check(status in ('requested','processing','completed','failed','cancelled')),
  provider_job_name text unique check(length(provider_job_name) between 1 and 200),
  failure_code text check(length(failure_code) between 1 and 80),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(recording_id,command_id),
  check(status<>'processing' or provider_job_name is not null),
  check((status='failed')=(failure_code is not null))
);
create unique index recording_transcription_one_open on clinical_private.recording_transcription_jobs(recording_id)
  where status in ('requested','processing');
create table clinical_private.recording_transcripts (
  id uuid primary key default gen_random_uuid(),
  recording_id uuid not null references clinical_private.encounter_captures(id),
  job_id uuid not null references clinical_private.recording_transcription_jobs(id),
  version integer not null check(version>0),
  kind text not null check(kind in ('provider','correction')),
  content_sha256 text not null check(content_sha256 ~ '^[a-f0-9]{64}$'),
  object_key text not null unique check(length(object_key) between 1 and 512),
  byte_length integer not null check(byte_length between 1 and 16777216),
  word_count integer not null check(word_count>=0),
  supersedes_id uuid references clinical_private.recording_transcripts(id),
  author_id uuid not null references clinical_core.persons(id),
  reason text check(length(btrim(reason)) between 1 and 400),
  created_at timestamptz not null default clock_timestamp(),
  unique(recording_id,version),
  check((kind='provider')=(version=1)),
  check((kind='correction')=(supersedes_id is not null)),
  check((kind='correction')=(reason is not null))
);
create table clinical_private.recording_transcription_events (
  id uuid primary key default gen_random_uuid(),
  recording_id uuid not null references clinical_private.encounter_captures(id),
  job_id uuid references clinical_private.recording_transcription_jobs(id),
  actor_id uuid not null references clinical_core.persons(id),
  action text not null check(action in ('transcription.requested','transcription.processing','transcription.completed',
    'transcription.failed','transcription.cancelled','transcript.corrected','transcripts.listed','transcript.read')),
  created_at timestamptz not null default clock_timestamp()
);
create index recording_transcription_events_recording on clinical_private.recording_transcription_events(recording_id,created_at,id);
alter table clinical_private.recording_transcription_releases enable row level security;
alter table clinical_private.recording_transcription_releases force row level security;
alter table clinical_private.recording_transcription_jobs enable row level security;
alter table clinical_private.recording_transcription_jobs force row level security;
alter table clinical_private.recording_transcripts enable row level security;
alter table clinical_private.recording_transcripts force row level security;
alter table clinical_private.recording_transcription_events enable row level security;
alter table clinical_private.recording_transcription_events force row level security;
revoke all on clinical_private.recording_transcription_releases,clinical_private.recording_transcription_jobs,
  clinical_private.recording_transcripts,clinical_private.recording_transcription_events from public,clinical_core_api;
create trigger recording_transcription_release_immutable before update or delete on clinical_private.recording_transcription_releases
  for each row execute function clinical_private.guard_recording_release_update();
create trigger recording_transcripts_immutable before update or delete on clinical_private.recording_transcripts
  for each row execute function clinical_private.block_update_delete();
create trigger recording_transcription_events_immutable before update or delete on clinical_private.recording_transcription_events
  for each row execute function clinical_private.block_update_delete();

create function clinical_private.require_recording_transcription_release(_release uuid,_org uuid)
returns clinical_private.recording_transcription_releases language plpgsql security definer set search_path='' as $$
declare _r clinical_private.recording_transcription_releases;
begin
  select * into _r from clinical_private.recording_transcription_releases where id=_release;
  if not found or _r.organization_id<>_org or _r.retired_at is not null or _r.approved_at>clock_timestamp() or _r.expires_at<=clock_timestamp()
    or _r.configuration_sha256<>encode(public.digest(_r.configuration::text,'sha256'),'hex')
    or _r.configuration->>'provider' is distinct from 'aws_transcribe' or (_r.configuration->>'region') !~ '^us-(east|west)-[12]$' then
    raise exception using errcode='42501',message='recording_transcription_release_refused'; end if;
  return _r;
end $$;

-- Every blocker is re-checked at request, completion and correction time.
create function clinical_private.assert_recording_transcribable(_r clinical_private.encounter_captures)
returns void language plpgsql security definer set search_path='' as $$
declare _e clinical_core.encounters; _stored integer; _pending integer;
begin
  select * into _e from clinical_core.encounters where id=_r.encounter_id;
  if _r.status<>'closed' or not exists(select 1 from clinical_private.recording_dispositions where recording_id=_r.id and disposition='finish') then
    raise exception using errcode='55000',message='recording_transcription_refused'; end if;
  if exists(select 1 from clinical_private.recording_legal_holds h where h.patient_record_id=_e.patient_record_id
      and h.organization_id=_e.organization_id and h.released_at is null) then
    raise exception using errcode='55000',message='recording_legal_hold'; end if;
  if exists(select 1 from clinical_private.recording_cleanup_intents where recording_id=_r.id and reason in ('discard','consent_revoked')) then
    raise exception using errcode='55000',message='recording_transcription_refused'; end if;
  if _r.deletion_deadline<=clock_timestamp() then raise exception using errcode='55000',message='recording_transcription_refused'; end if;
  select count(*) filter(where status='stored'),count(*) filter(where status='reserved') into _stored,_pending
    from clinical_private.recording_segments where recording_id=_r.id;
  if _stored=0 or _pending<>0 then raise exception using errcode='55000',message='recording_segments_unresolved'; end if;
end $$;

create function clinical_private.request_recording_transcription(_recording uuid,_command uuid,_release uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _r clinical_private.encounter_captures; _e clinical_core.encounters; _prior clinical_private.recording_transcription_jobs;
  _grants uuid[]; _inventory jsonb; _hash text; _count integer; _job clinical_private.recording_transcription_jobs;
begin
  _r:=clinical_private.lock_owned_recording(_recording);
  if _command is null or _release is null then raise exception using errcode='22023',message='recording_transcription_invalid'; end if;
  select * into _e from clinical_core.encounters where id=_r.encounter_id;
  select * into _prior from clinical_private.recording_transcription_jobs where recording_id=_recording and command_id=_command;
  if found then
    if _prior.requested_by<>clinical_private.actor_person_id() or _prior.release_id<>_release then
      raise exception using errcode='40001',message='recording_transcription_conflict'; end if;
    return jsonb_build_object('jobId',_prior.id,'recordingId',_recording,'commandId',_command,'status',_prior.status,
      'segmentCount',_prior.segment_count,'inventorySha256',_prior.inventory_sha256,'replayed',true);
  end if;
  perform clinical_private.require_recording_transcription_release(_release,_e.organization_id);
  perform clinical_private.assert_recording_transcribable(_r);
  if exists(select 1 from clinical_private.recording_transcription_jobs where recording_id=_recording and status in ('requested','processing')) then
    raise exception using errcode='40001',message='recording_transcription_conflict'; end if;
  _grants:=clinical_private.recording_grants_for_scope(_r.encounter_id,'transcription',_r.participant_ids);
  _inventory:=clinical_private.recording_segment_inventory(_recording);
  _hash:=encode(public.digest(_inventory::text,'sha256'),'hex');
  select count(*) into _count from clinical_private.recording_segments where recording_id=_recording and status='stored';
  insert into clinical_private.recording_transcription_jobs(recording_id,release_id,command_id,requested_by,participant_ids,transcription_grant_ids,segment_count,inventory_sha256)
    values(_recording,_release,_command,clinical_private.actor_person_id(),_r.participant_ids,_grants,_count,_hash) returning * into _job;
  insert into clinical_private.recording_transcription_events(recording_id,job_id,actor_id,action)
    values(_recording,_job.id,clinical_private.actor_person_id(),'transcription.requested');
  return jsonb_build_object('jobId',_job.id,'recordingId',_recording,'commandId',_command,'status',_job.status,
    'segmentCount',_job.segment_count,'inventorySha256',_job.inventory_sha256,'replayed',false);
end $$;

create function clinical_private.owned_transcription_job(_job uuid)
returns clinical_private.recording_transcription_jobs language plpgsql security definer set search_path='' as $$
declare _j clinical_private.recording_transcription_jobs;
begin
  select * into _j from clinical_private.recording_transcription_jobs where id=_job;
  if not found then raise exception using errcode='42501',message='recording_access_refused'; end if;
  perform clinical_private.lock_owned_recording(_j.recording_id);
  select * into _j from clinical_private.recording_transcription_jobs where id=_job for update;
  return _j;
end $$;

create function clinical_private.mark_recording_transcription_processing(_job uuid,_provider_job_name text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _j clinical_private.recording_transcription_jobs;
begin
  _j:=clinical_private.owned_transcription_job(_job);
  if _provider_job_name is null or length(_provider_job_name) not between 1 and 200 then
    raise exception using errcode='22023',message='recording_transcription_invalid'; end if;
  if _j.status='processing' and _j.provider_job_name=_provider_job_name then
    return jsonb_build_object('jobId',_j.id,'status',_j.status,'providerJobName',_j.provider_job_name,'replayed',true); end if;
  if _j.status<>'requested' then raise exception using errcode='40001',message='recording_transcription_conflict'; end if;
  update clinical_private.recording_transcription_jobs set status='processing',provider_job_name=_provider_job_name,updated_at=clock_timestamp()
    where id=_job returning * into _j;
  insert into clinical_private.recording_transcription_events(recording_id,job_id,actor_id,action)
    values(_j.recording_id,_j.id,clinical_private.actor_person_id(),'transcription.processing');
  return jsonb_build_object('jobId',_j.id,'status',_j.status,'providerJobName',_j.provider_job_name,'replayed',false);
end $$;

create function clinical_private.fail_recording_transcription(_job uuid,_code text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _j clinical_private.recording_transcription_jobs;
begin
  _j:=clinical_private.owned_transcription_job(_job);
  if _code is null or length(_code) not between 1 and 80 then raise exception using errcode='22023',message='recording_transcription_invalid'; end if;
  if _j.status='failed' then return jsonb_build_object('jobId',_j.id,'status',_j.status,'failureCode',_j.failure_code,'replayed',true); end if;
  if _j.status not in ('requested','processing') then raise exception using errcode='40001',message='recording_transcription_conflict'; end if;
  update clinical_private.recording_transcription_jobs set status='failed',failure_code=_code,updated_at=clock_timestamp() where id=_job returning * into _j;
  insert into clinical_private.recording_transcription_events(recording_id,job_id,actor_id,action)
    values(_j.recording_id,_j.id,clinical_private.actor_person_id(),'transcription.failed');
  return jsonb_build_object('jobId',_j.id,'status',_j.status,'failureCode',_j.failure_code,'replayed',false);
end $$;

-- Completion re-verifies consent and blockers: a withdrawal after the request
-- fails the job and stores no transcript.
create function clinical_private.complete_recording_transcription(_job uuid,_object_key text,_sha256 text,_bytes integer,_words integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _j clinical_private.recording_transcription_jobs; _r clinical_private.encounter_captures; _grants uuid[]; _t clinical_private.recording_transcripts;
begin
  _j:=clinical_private.owned_transcription_job(_job);
  if _object_key is null or length(_object_key) not between 1 and 512 or _sha256 !~ '^[a-f0-9]{64}$'
    or _bytes is null or _bytes not between 1 and 16777216 or _words is null or _words<0 then
    raise exception using errcode='22023',message='recording_transcription_invalid'; end if;
  select * into _t from clinical_private.recording_transcripts where job_id=_job and version=1;
  if found then
    if _t.content_sha256<>_sha256 or _t.object_key<>_object_key then raise exception using errcode='40001',message='recording_transcription_conflict'; end if;
    return jsonb_build_object('transcriptId',_t.id,'jobId',_j.id,'status','completed','version',1,'contentSha256',_t.content_sha256,'replayed',true);
  end if;
  if _j.status<>'processing' then raise exception using errcode='40001',message='recording_transcription_conflict'; end if;
  select * into _r from clinical_private.encounter_captures where id=_j.recording_id;
  begin
    perform clinical_private.assert_recording_transcribable(_r);
    _grants:=clinical_private.recording_grants_for_scope(_r.encounter_id,'transcription',_j.participant_ids);
    if _grants is distinct from _j.transcription_grant_ids then raise exception using errcode='55000',message='recording_consent_required'; end if;
  exception when others then
    -- Recorded, not raised: raising would roll the failure back with it.
    update clinical_private.recording_transcription_jobs set status='failed',failure_code=left(sqlerrm,80),updated_at=clock_timestamp() where id=_job;
    insert into clinical_private.recording_transcription_events(recording_id,job_id,actor_id,action)
      values(_j.recording_id,_j.id,clinical_private.actor_person_id(),'transcription.failed');
    return jsonb_build_object('jobId',_j.id,'status','failed','failureCode',left(sqlerrm,80),'transcriptId',null,'version',null,'replayed',false);
  end;
  insert into clinical_private.recording_transcripts(recording_id,job_id,version,kind,content_sha256,object_key,byte_length,word_count,author_id)
    values(_j.recording_id,_job,1,'provider',_sha256,_object_key,_bytes,_words,clinical_private.actor_person_id()) returning * into _t;
  update clinical_private.recording_transcription_jobs set status='completed',updated_at=clock_timestamp() where id=_job;
  insert into clinical_private.recording_transcription_events(recording_id,job_id,actor_id,action)
    values(_j.recording_id,_job,clinical_private.actor_person_id(),'transcription.completed');
  return jsonb_build_object('transcriptId',_t.id,'jobId',_j.id,'status','completed','version',1,'contentSha256',_t.content_sha256,'replayed',false);
end $$;

create function clinical_private.correct_recording_transcript(_recording uuid,_object_key text,_sha256 text,_bytes integer,_words integer,_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _r clinical_private.encounter_captures; _latest clinical_private.recording_transcripts; _t clinical_private.recording_transcripts;
begin
  _r:=clinical_private.lock_owned_recording(_recording);
  if _object_key is null or length(_object_key) not between 1 and 512 or _sha256 !~ '^[a-f0-9]{64}$'
    or _bytes is null or _bytes not between 1 and 16777216 or _words is null or _words<0
    or _reason is null or length(btrim(_reason)) not between 1 and 400 then
    raise exception using errcode='22023',message='recording_transcription_invalid'; end if;
  select * into _latest from clinical_private.recording_transcripts where recording_id=_recording order by version desc limit 1;
  if not found then raise exception using errcode='55000',message='recording_transcript_missing'; end if;
  if _latest.content_sha256=_sha256 then raise exception using errcode='40001',message='recording_transcription_conflict'; end if;
  perform clinical_private.assert_recording_transcribable(_r);
  insert into clinical_private.recording_transcripts(recording_id,job_id,version,kind,content_sha256,object_key,byte_length,word_count,supersedes_id,author_id,reason)
    values(_recording,_latest.job_id,_latest.version+1,'correction',_sha256,_object_key,_bytes,_words,_latest.id,clinical_private.actor_person_id(),btrim(_reason)) returning * into _t;
  insert into clinical_private.recording_transcription_events(recording_id,job_id,actor_id,action)
    values(_recording,_latest.job_id,clinical_private.actor_person_id(),'transcript.corrected');
  return jsonb_build_object('transcriptId',_t.id,'jobId',_t.job_id,'version',_t.version,'supersedesId',_t.supersedes_id,'contentSha256',_t.content_sha256);
end $$;

create function clinical_private.list_recording_transcripts(_recording uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _r clinical_private.encounter_captures; _job jsonb; _versions jsonb;
begin
  _r:=clinical_private.lock_owned_recording(_recording);
  select to_jsonb(j)-'participant_ids'-'transcription_grant_ids' into _job from (select id as "jobId",status,provider_job_name as "providerJobName",failure_code as "failureCode",
      segment_count as "segmentCount",inventory_sha256 as "inventorySha256",created_at as "createdAt",updated_at as "updatedAt",participant_ids,transcription_grant_ids
    from clinical_private.recording_transcription_jobs where recording_id=_recording order by created_at desc limit 1) j;
  select coalesce(jsonb_agg(jsonb_build_object('transcriptId',t.id,'version',t.version,'kind',t.kind,'contentSha256',t.content_sha256,
    'byteLength',t.byte_length,'wordCount',t.word_count,'supersedesId',t.supersedes_id,'authorId',t.author_id,'reason',t.reason,'createdAt',t.created_at) order by t.version),'[]'::jsonb)
    into _versions from clinical_private.recording_transcripts t where t.recording_id=_recording;
  insert into clinical_private.recording_transcription_events(recording_id,job_id,actor_id,action)
    values(_recording,null,clinical_private.actor_person_id(),'transcripts.listed');
  return jsonb_build_object('recordingId',_recording,'status',_r.status,'job',_job,'versions',_versions);
end $$;

create function clinical_private.get_recording_transcript_object(_transcript uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _t clinical_private.recording_transcripts; _r clinical_private.encounter_captures; _org uuid; _storage clinical_private.recording_storage_releases;
begin
  select * into _t from clinical_private.recording_transcripts where id=_transcript;
  if not found then raise exception using errcode='42501',message='recording_access_refused'; end if;
  _r:=clinical_private.lock_owned_recording(_t.recording_id);
  perform clinical_private.assert_recording_transcribable(_r);
  select organization_id into _org from clinical_private.recording_controls where encounter_id=_r.encounter_id;
  _storage:=clinical_private.require_recording_storage_release(_r.release_id,_org);
  insert into clinical_private.recording_transcription_events(recording_id,job_id,actor_id,action)
    values(_t.recording_id,_t.job_id,clinical_private.actor_person_id(),'transcript.read');
  return jsonb_build_object('transcriptId',_t.id,'recordingId',_t.recording_id,'version',_t.version,'objectKey',_t.object_key,
    'contentSha256',_t.content_sha256,'byteLength',_t.byte_length,'storage',_storage.configuration);
end $$;

-- Media inventory for the processor: stored segment objects in order plus the
-- storage release the capture wrote under. Only for an open job the owner
-- requested, and only while every blocker still passes. No audio bytes here.
create function clinical_private.get_recording_transcription_media(_job uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _j clinical_private.recording_transcription_jobs; _r clinical_private.encounter_captures; _org uuid;
  _storage clinical_private.recording_storage_releases; _release clinical_private.recording_transcription_releases; _segments jsonb;
begin
  _j:=clinical_private.owned_transcription_job(_job);
  if _j.status not in ('requested','processing') then raise exception using errcode='40001',message='recording_transcription_conflict'; end if;
  select * into _r from clinical_private.encounter_captures where id=_j.recording_id;
  perform clinical_private.assert_recording_transcribable(_r);
  select organization_id into _org from clinical_private.recording_controls where encounter_id=_r.encounter_id;
  _storage:=clinical_private.require_recording_storage_release(_r.release_id,_org);
  _release:=clinical_private.require_recording_transcription_release(_j.release_id,_org);
  if encode(public.digest(clinical_private.recording_segment_inventory(_j.recording_id)::text,'sha256'),'hex')<>_j.inventory_sha256 then
    raise exception using errcode='40001',message='recording_inventory_changed'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('sequence',s.sequence,'objectKey',s.object_key,'objectVersion',s.object_version,
    'sha256',s.content_sha256,'bytes',s.byte_length) order by s.sequence),'[]'::jsonb) into _segments
    from clinical_private.recording_segments s where s.recording_id=_j.recording_id and s.status='stored';
  return jsonb_build_object('jobId',_j.id,'recordingId',_j.recording_id,'organizationId',_org,'contentType',_r.content_type,
    'status',_j.status,'providerJobName',_j.provider_job_name,'storage',_storage.configuration,'provider',_release.configuration,'segments',_segments);
end $$;

revoke all on function clinical_private.require_recording_transcription_release(uuid,uuid),clinical_private.assert_recording_transcribable(clinical_private.encounter_captures),
  clinical_private.owned_transcription_job(uuid) from public,clinical_core_api;
revoke all on function clinical_private.request_recording_transcription(uuid,uuid,uuid),clinical_private.mark_recording_transcription_processing(uuid,text),
  clinical_private.fail_recording_transcription(uuid,text),clinical_private.complete_recording_transcription(uuid,text,text,integer,integer),
  clinical_private.correct_recording_transcript(uuid,text,text,integer,integer,text),clinical_private.list_recording_transcripts(uuid),
  clinical_private.get_recording_transcript_object(uuid),clinical_private.get_recording_transcription_media(uuid) from public;
grant execute on function clinical_private.request_recording_transcription(uuid,uuid,uuid),clinical_private.mark_recording_transcription_processing(uuid,text),
  clinical_private.fail_recording_transcription(uuid,text),clinical_private.complete_recording_transcription(uuid,text,text,integer,integer),
  clinical_private.correct_recording_transcript(uuid,text,text,integer,integer,text),clinical_private.list_recording_transcripts(uuid),
  clinical_private.get_recording_transcript_object(uuid),clinical_private.get_recording_transcription_media(uuid) to clinical_core_api;
