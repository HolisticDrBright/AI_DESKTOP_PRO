-- Encounter AI drafting authority: review-only proposed notes from a stored
-- transcript version. No provider approval, job or proposed note is seeded.
-- A proposed note is never a clinical note: nothing here reads or writes
-- clinical_core notes, signatures or addenda. Drafting requires every
-- participant's current ai_drafting consent, an approved provider release for
-- the organization, the recording's latest transcript version, no hold and no
-- actionable cleanup intent. Proposed notes are immutable versions.
create table clinical_private.recording_drafting_releases (
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
create table clinical_private.recording_drafting_jobs (
  id uuid primary key default gen_random_uuid(),
  recording_id uuid not null references clinical_private.encounter_captures(id),
  transcript_id uuid not null references clinical_private.recording_transcripts(id),
  release_id uuid not null references clinical_private.recording_drafting_releases(id),
  command_id uuid not null,
  requested_by uuid not null references clinical_core.persons(id),
  note_type text not null check(note_type in ('soap','narrative','follow_up','adime','patient_instructions')),
  participant_ids uuid[] not null check(cardinality(participant_ids)>0),
  drafting_grant_ids uuid[] not null check(cardinality(drafting_grant_ids)>0),
  status text not null default 'requested' check(status in ('requested','completed','failed','cancelled')),
  failure_code text check(length(failure_code) between 1 and 80),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(recording_id,command_id),
  check((status='failed')=(failure_code is not null))
);
create unique index recording_drafting_one_open on clinical_private.recording_drafting_jobs(recording_id) where status='requested';
create table clinical_private.recording_proposed_notes (
  id uuid primary key default gen_random_uuid(),
  recording_id uuid not null references clinical_private.encounter_captures(id),
  job_id uuid not null unique references clinical_private.recording_drafting_jobs(id),
  transcript_id uuid not null references clinical_private.recording_transcripts(id),
  note_type text not null check(note_type in ('soap','narrative','follow_up','adime','patient_instructions')),
  version integer not null check(version>0),
  content_sha256 text not null check(content_sha256 ~ '^[a-f0-9]{64}$'),
  object_key text not null unique check(length(object_key) between 1 and 512),
  byte_length integer not null check(byte_length between 1 and 1048576),
  section_count integer not null check(section_count between 1 and 8),
  model text not null check(length(model) between 3 and 100),
  created_by uuid not null references clinical_core.persons(id),
  created_at timestamptz not null default clock_timestamp(),
  unique(recording_id,version)
);
create table clinical_private.recording_drafting_events (
  id uuid primary key default gen_random_uuid(),
  recording_id uuid not null references clinical_private.encounter_captures(id),
  job_id uuid references clinical_private.recording_drafting_jobs(id),
  actor_id uuid not null references clinical_core.persons(id),
  action text not null check(action in ('drafting.requested','drafting.completed','drafting.failed','drafting.cancelled',
    'proposed_notes.listed','proposed_note.read','artifact.registered')),
  created_at timestamptz not null default clock_timestamp()
);
create index recording_drafting_events_recording on clinical_private.recording_drafting_events(recording_id,created_at,id);
alter table clinical_private.recording_drafting_releases enable row level security;
alter table clinical_private.recording_drafting_releases force row level security;
alter table clinical_private.recording_drafting_jobs enable row level security;
alter table clinical_private.recording_drafting_jobs force row level security;
alter table clinical_private.recording_proposed_notes enable row level security;
alter table clinical_private.recording_proposed_notes force row level security;
alter table clinical_private.recording_drafting_events enable row level security;
alter table clinical_private.recording_drafting_events force row level security;
revoke all on clinical_private.recording_drafting_releases,clinical_private.recording_drafting_jobs,
  clinical_private.recording_proposed_notes,clinical_private.recording_drafting_events from public,clinical_core_api;
create trigger recording_drafting_release_immutable before update or delete on clinical_private.recording_drafting_releases
  for each row execute function clinical_private.guard_recording_release_update();
create trigger recording_proposed_notes_immutable before update or delete on clinical_private.recording_proposed_notes
  for each row execute function clinical_private.block_update_delete();
create trigger recording_drafting_events_immutable before update or delete on clinical_private.recording_drafting_events
  for each row execute function clinical_private.block_update_delete();

-- Proposed-note objects join the artifact registry so cleanup removes them with the recording.
alter table clinical_private.recording_transcription_artifacts alter column job_id drop not null;
alter table clinical_private.recording_transcription_artifacts add column drafting_job_id uuid references clinical_private.recording_drafting_jobs(id);
alter table clinical_private.recording_transcription_artifacts add column proposed_note_id uuid unique references clinical_private.recording_proposed_notes(id);
alter table clinical_private.recording_transcription_artifacts drop constraint recording_transcription_artifacts_kind_check;
alter table clinical_private.recording_transcription_artifacts add constraint recording_transcription_artifacts_kind_check
  check(kind in ('media','provider','transcript','proposed_note'));
alter table clinical_private.recording_transcription_artifacts add constraint recording_transcription_artifacts_one_job check((job_id is null)<>(drafting_job_id is null));
alter table clinical_private.recording_transcription_artifacts add constraint recording_transcription_artifacts_proposed_note check((kind='proposed_note')=(proposed_note_id is not null));
alter table clinical_private.recording_transcription_artifacts add constraint recording_transcription_artifacts_drafting_kind check((drafting_job_id is null) or kind='proposed_note');

create function clinical_private.require_recording_drafting_release(_release uuid,_org uuid)
returns clinical_private.recording_drafting_releases language plpgsql security definer set search_path='' as $$
declare _r clinical_private.recording_drafting_releases;
begin
  select * into _r from clinical_private.recording_drafting_releases where id=_release;
  if not found or _r.organization_id<>_org or _r.retired_at is not null or _r.approved_at>clock_timestamp() or _r.expires_at<=clock_timestamp()
    or _r.configuration_sha256<>encode(public.digest(_r.configuration::text,'sha256'),'hex')
    or _r.configuration->>'provider' is distinct from 'openai_responses' or length(coalesce(_r.configuration->>'model','')) not between 3 and 100
    or (_r.configuration->>'promptSha256') !~ '^[a-f0-9]{64}$' or (_r.configuration->>'zeroDataRetention')::boolean is distinct from true then
    raise exception using errcode='42501',message='recording_drafting_release_refused'; end if;
  return _r;
end $$;

create function clinical_private.owned_drafting_job(_job uuid)
returns clinical_private.recording_drafting_jobs language plpgsql security definer set search_path='' as $$
declare _j clinical_private.recording_drafting_jobs;
begin
  select * into _j from clinical_private.recording_drafting_jobs where id=_job;
  if not found then raise exception using errcode='42501',message='recording_access_refused'; end if;
  perform clinical_private.lock_owned_recording(_j.recording_id);
  select * into _j from clinical_private.recording_drafting_jobs where id=_job for update;
  return _j;
end $$;

-- Only the recording's latest transcript version may be drafted from, so a
-- proposed note never silently describes superseded text.
create function clinical_private.request_recording_drafting(_recording uuid,_transcript uuid,_command uuid,_release uuid,_note_type text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _r clinical_private.encounter_captures; _e clinical_core.encounters; _prior clinical_private.recording_drafting_jobs; _t clinical_private.recording_transcripts;
  _grants uuid[]; _job clinical_private.recording_drafting_jobs;
begin
  _r:=clinical_private.lock_owned_recording(_recording);
  if _command is null or _release is null or _transcript is null or _note_type is null
    or _note_type not in ('soap','narrative','follow_up','adime','patient_instructions') then
    raise exception using errcode='22023',message='recording_drafting_invalid'; end if;
  select * into _e from clinical_core.encounters where id=_r.encounter_id;
  select * into _prior from clinical_private.recording_drafting_jobs where recording_id=_recording and command_id=_command;
  if found then
    if _prior.requested_by<>clinical_private.actor_person_id() or _prior.release_id<>_release or _prior.transcript_id<>_transcript or _prior.note_type<>_note_type then
      raise exception using errcode='40001',message='recording_drafting_conflict'; end if;
    return jsonb_build_object('jobId',_prior.id,'recordingId',_recording,'transcriptId',_transcript,'commandId',_command,'noteType',_prior.note_type,
      'status',_prior.status,'replayed',true);
  end if;
  perform clinical_private.require_recording_drafting_release(_release,_e.organization_id);
  perform clinical_private.assert_recording_transcribable(_r);
  select * into _t from clinical_private.recording_transcripts where id=_transcript and recording_id=_recording;
  if not found then raise exception using errcode='55000',message='recording_transcript_missing'; end if;
  if _t.version<>(select max(version) from clinical_private.recording_transcripts where recording_id=_recording) then
    raise exception using errcode='40001',message='recording_drafting_conflict'; end if;
  if exists(select 1 from clinical_private.recording_drafting_jobs where recording_id=_recording and status='requested') then
    raise exception using errcode='40001',message='recording_drafting_conflict'; end if;
  _grants:=clinical_private.recording_grants_for_scope(_r.encounter_id,'ai_drafting',_r.participant_ids);
  insert into clinical_private.recording_drafting_jobs(recording_id,transcript_id,release_id,command_id,requested_by,note_type,participant_ids,drafting_grant_ids)
    values(_recording,_transcript,_release,_command,clinical_private.actor_person_id(),_note_type,_r.participant_ids,_grants) returning * into _job;
  insert into clinical_private.recording_drafting_events(recording_id,job_id,actor_id,action)
    values(_recording,_job.id,clinical_private.actor_person_id(),'drafting.requested');
  return jsonb_build_object('jobId',_job.id,'recordingId',_recording,'transcriptId',_transcript,'commandId',_command,'noteType',_job.note_type,
    'status',_job.status,'replayed',false);
end $$;

-- Processor input: the transcript object to read and the pinned provider
-- configuration. Only for an open job the owner requested, and only while every
-- blocker and the grants the job relied on still hold. No text here.
create function clinical_private.get_recording_drafting_input(_job uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _j clinical_private.recording_drafting_jobs; _r clinical_private.encounter_captures; _t clinical_private.recording_transcripts; _org uuid;
  _storage clinical_private.recording_storage_releases; _release clinical_private.recording_drafting_releases; _grants uuid[];
begin
  _j:=clinical_private.owned_drafting_job(_job);
  if _j.status<>'requested' then raise exception using errcode='40001',message='recording_drafting_conflict'; end if;
  select * into _r from clinical_private.encounter_captures where id=_j.recording_id;
  perform clinical_private.assert_recording_transcribable(_r);
  _grants:=clinical_private.recording_grants_for_scope(_r.encounter_id,'ai_drafting',_j.participant_ids);
  if _grants is distinct from _j.drafting_grant_ids then raise exception using errcode='55000',message='recording_consent_required'; end if;
  select organization_id into _org from clinical_private.recording_controls where encounter_id=_r.encounter_id;
  _storage:=clinical_private.require_recording_storage_release(_r.release_id,_org);
  _release:=clinical_private.require_recording_drafting_release(_j.release_id,_org);
  select * into _t from clinical_private.recording_transcripts where id=_j.transcript_id;
  return jsonb_build_object('jobId',_j.id,'recordingId',_j.recording_id,'organizationId',_org,'noteType',_j.note_type,'status',_j.status,
    'transcript',jsonb_build_object('transcriptId',_t.id,'version',_t.version,'objectKey',_t.object_key,'contentSha256',_t.content_sha256,'byteLength',_t.byte_length),
    'storage',_storage.configuration,'provider',_release.configuration);
end $$;

create function clinical_private.fail_recording_drafting(_job uuid,_code text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _j clinical_private.recording_drafting_jobs;
begin
  _j:=clinical_private.owned_drafting_job(_job);
  if _code is null or length(_code) not between 1 and 80 then raise exception using errcode='22023',message='recording_drafting_invalid'; end if;
  if _j.status='failed' then return jsonb_build_object('jobId',_j.id,'status',_j.status,'failureCode',_j.failure_code,'replayed',true); end if;
  if _j.status<>'requested' then raise exception using errcode='40001',message='recording_drafting_conflict'; end if;
  update clinical_private.recording_drafting_jobs set status='failed',failure_code=_code,updated_at=clock_timestamp() where id=_job returning * into _j;
  insert into clinical_private.recording_drafting_events(recording_id,job_id,actor_id,action)
    values(_j.recording_id,_j.id,clinical_private.actor_person_id(),'drafting.failed');
  return jsonb_build_object('jobId',_j.id,'status',_j.status,'failureCode',_j.failure_code,'replayed',false);
end $$;

-- Completion re-verifies consent and blockers: a withdrawal after the request
-- fails the job and stores no proposed note. Recorded, not raised.
create function clinical_private.complete_recording_drafting(_job uuid,_object_key text,_sha256 text,_bytes integer,_sections integer,_model text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _j clinical_private.recording_drafting_jobs; _r clinical_private.encounter_captures; _grants uuid[]; _n clinical_private.recording_proposed_notes; _version integer;
begin
  _j:=clinical_private.owned_drafting_job(_job);
  if _object_key is null or length(_object_key) not between 1 and 512 or _sha256 !~ '^[a-f0-9]{64}$'
    or _bytes is null or _bytes not between 1 and 1048576 or _sections is null or _sections not between 1 and 8
    or _model is null or length(_model) not between 3 and 100 then
    raise exception using errcode='22023',message='recording_drafting_invalid'; end if;
  select * into _n from clinical_private.recording_proposed_notes where job_id=_job;
  if found then
    if _n.content_sha256<>_sha256 or _n.object_key<>_object_key then raise exception using errcode='40001',message='recording_drafting_conflict'; end if;
    return jsonb_build_object('proposedNoteId',_n.id,'jobId',_j.id,'status','completed','version',_n.version,'contentSha256',_n.content_sha256,'replayed',true);
  end if;
  if _j.status<>'requested' then raise exception using errcode='40001',message='recording_drafting_conflict'; end if;
  select * into _r from clinical_private.encounter_captures where id=_j.recording_id;
  begin
    perform clinical_private.assert_recording_transcribable(_r);
    _grants:=clinical_private.recording_grants_for_scope(_r.encounter_id,'ai_drafting',_j.participant_ids);
    if _grants is distinct from _j.drafting_grant_ids then raise exception using errcode='55000',message='recording_consent_required'; end if;
    if (select max(version) from clinical_private.recording_transcripts where recording_id=_j.recording_id)<>(select version from clinical_private.recording_transcripts where id=_j.transcript_id) then
      raise exception using errcode='40001',message='recording_transcript_superseded'; end if;
  exception when others then
    update clinical_private.recording_drafting_jobs set status='failed',failure_code=left(sqlerrm,80),updated_at=clock_timestamp() where id=_job;
    insert into clinical_private.recording_drafting_events(recording_id,job_id,actor_id,action)
      values(_j.recording_id,_j.id,clinical_private.actor_person_id(),'drafting.failed');
    return jsonb_build_object('jobId',_j.id,'status','failed','failureCode',left(sqlerrm,80),'proposedNoteId',null,'version',null,'replayed',false);
  end;
  select coalesce(max(version),0)+1 into _version from clinical_private.recording_proposed_notes where recording_id=_j.recording_id;
  insert into clinical_private.recording_proposed_notes(recording_id,job_id,transcript_id,note_type,version,content_sha256,object_key,byte_length,section_count,model,created_by)
    values(_j.recording_id,_job,_j.transcript_id,_j.note_type,_version,_sha256,_object_key,_bytes,_sections,_model,clinical_private.actor_person_id()) returning * into _n;
  update clinical_private.recording_drafting_jobs set status='completed',updated_at=clock_timestamp() where id=_job;
  insert into clinical_private.recording_drafting_events(recording_id,job_id,actor_id,action)
    values(_j.recording_id,_job,clinical_private.actor_person_id(),'drafting.completed');
  return jsonb_build_object('proposedNoteId',_n.id,'jobId',_j.id,'status','completed','version',_n.version,'contentSha256',_n.content_sha256,'replayed',false);
end $$;

create function clinical_private.list_recording_proposed_notes(_recording uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _r clinical_private.encounter_captures; _job jsonb; _versions jsonb; _transcript jsonb;
begin
  _r:=clinical_private.lock_owned_recording(_recording);
  select to_jsonb(j) into _job from (select id as "jobId",status,note_type as "noteType",transcript_id as "transcriptId",failure_code as "failureCode",
      created_at as "createdAt",updated_at as "updatedAt"
    from clinical_private.recording_drafting_jobs where recording_id=_recording order by created_at desc limit 1) j;
  select jsonb_build_object('transcriptId',t.id,'version',t.version) into _transcript from clinical_private.recording_transcripts t
    where t.recording_id=_recording order by t.version desc limit 1;
  select coalesce(jsonb_agg(jsonb_build_object('proposedNoteId',n.id,'version',n.version,'noteType',n.note_type,'transcriptId',n.transcript_id,
    'contentSha256',n.content_sha256,'byteLength',n.byte_length,'sectionCount',n.section_count,'model',n.model,'createdBy',n.created_by,'createdAt',n.created_at) order by n.version),'[]'::jsonb)
    into _versions from clinical_private.recording_proposed_notes n where n.recording_id=_recording;
  insert into clinical_private.recording_drafting_events(recording_id,job_id,actor_id,action)
    values(_recording,null,clinical_private.actor_person_id(),'proposed_notes.listed');
  return jsonb_build_object('recordingId',_recording,'status',_r.status,'latestTranscript',_transcript,'job',_job,'versions',_versions);
end $$;

create function clinical_private.get_recording_proposed_note_object(_note uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _n clinical_private.recording_proposed_notes; _r clinical_private.encounter_captures; _org uuid; _storage clinical_private.recording_storage_releases;
begin
  select * into _n from clinical_private.recording_proposed_notes where id=_note;
  if not found then raise exception using errcode='42501',message='recording_access_refused'; end if;
  _r:=clinical_private.lock_owned_recording(_n.recording_id);
  perform clinical_private.assert_recording_transcribable(_r);
  select organization_id into _org from clinical_private.recording_controls where encounter_id=_r.encounter_id;
  _storage:=clinical_private.require_recording_storage_release(_r.release_id,_org);
  insert into clinical_private.recording_drafting_events(recording_id,job_id,actor_id,action)
    values(_n.recording_id,_n.job_id,clinical_private.actor_person_id(),'proposed_note.read');
  return jsonb_build_object('proposedNoteId',_n.id,'recordingId',_n.recording_id,'transcriptId',_n.transcript_id,'noteType',_n.note_type,'version',_n.version,
    'objectKey',_n.object_key,'contentSha256',_n.content_sha256,'byteLength',_n.byte_length,'storage',_storage.configuration);
end $$;

create function clinical_private.register_recording_drafting_artifact(_job uuid,_object_key text,_object_version text,_sha256 text,_bytes integer,_note uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _j clinical_private.recording_drafting_jobs; _r clinical_private.encounter_captures; _org uuid; _prefix text; _n clinical_private.recording_proposed_notes;
  _existing clinical_private.recording_transcription_artifacts; _id uuid;
begin
  _j:=clinical_private.owned_drafting_job(_job);
  select * into _r from clinical_private.encounter_captures where id=_j.recording_id;
  select organization_id into _org from clinical_private.recording_controls where encounter_id=_r.encounter_id;
  _prefix:='encounter-recordings/'||_org||'/'||_j.recording_id||'/drafting/'||_j.id||'/';
  if _object_key is null or length(_object_key) not between 1 and 512 or left(_object_key,length(_prefix))<>_prefix
    or substr(_object_key,length(_prefix)+1)!~'^proposed-v[1-9][0-9]*\.json$'
    or _object_version is null or length(_object_version) not between 1 and 1024 or _object_version='null' or _object_version!~'^[A-Za-z0-9+/=._-]+$'
    or _sha256 is null or _sha256!~'^[a-f0-9]{64}$' or _bytes is null or _bytes not between 1 and 1048576 or _note is null then
    raise exception using errcode='22023',message='recording_transcription_artifact_invalid'; end if;
  select * into _n from clinical_private.recording_proposed_notes where id=_note;
  if not found or _n.job_id<>_j.id or _n.object_key<>_object_key or _n.content_sha256<>_sha256 or _n.byte_length<>_bytes then
    raise exception using errcode='22023',message='recording_transcription_artifact_invalid'; end if;
  select * into _existing from clinical_private.recording_transcription_artifacts where object_key=_object_key;
  if found then
    if _existing.drafting_job_id is distinct from _j.id or _existing.kind<>'proposed_note' or _existing.object_version<>_object_version
      or _existing.content_sha256<>_sha256 or _existing.byte_length<>_bytes or _existing.proposed_note_id is distinct from _note then
      raise exception using errcode='40001',message='recording_transcription_artifact_conflict'; end if;
    return jsonb_build_object('artifactId',_existing.id,'jobId',_j.id,'kind','proposed_note','replayed',true);
  end if;
  insert into clinical_private.recording_transcription_artifacts(drafting_job_id,recording_id,kind,object_key,object_version,content_sha256,byte_length,proposed_note_id,registered_by)
    values(_j.id,_j.recording_id,'proposed_note',_object_key,_object_version,_sha256,_bytes,_note,clinical_private.actor_person_id()) returning id into _id;
  insert into clinical_private.recording_drafting_events(recording_id,job_id,actor_id,action)
    values(_j.recording_id,_j.id,clinical_private.actor_person_id(),'artifact.registered');
  return jsonb_build_object('artifactId',_id,'jobId',_j.id,'kind','proposed_note','replayed',false);
end $$;

create or replace function clinical_private.recording_transcription_inventory(_recording uuid) returns jsonb
language sql security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('artifactId',id,'jobId',coalesce(job_id,drafting_job_id),'kind',kind,'objectKey',object_key,'objectVersion',object_version,
    'sha256',content_sha256,'bytes',byte_length,'transcriptId',transcript_id) order by created_at,id),'[]'::jsonb)
  from clinical_private.recording_transcription_artifacts where recording_id=_recording
$$;

create or replace function clinical_private.recording_cleanup_cancels_transcription() returns trigger
language plpgsql security definer set search_path='' as $$
declare _j clinical_private.recording_transcription_jobs; _d clinical_private.recording_drafting_jobs;
begin
  if new.reason not in ('discard','consent_revoked') and new.due_at>clock_timestamp() then return new; end if;
  for _j in select * from clinical_private.recording_transcription_jobs where recording_id=new.recording_id and status in ('requested','processing') order by id loop
    update clinical_private.recording_transcription_jobs set status='cancelled',updated_at=clock_timestamp() where id=_j.id;
    insert into clinical_private.recording_transcription_events(recording_id,job_id,actor_id,action)
      values(_j.recording_id,_j.id,clinical_private.actor_person_id(),'transcription.cancelled');
  end loop;
  for _d in select * from clinical_private.recording_drafting_jobs where recording_id=new.recording_id and status='requested' order by id loop
    update clinical_private.recording_drafting_jobs set status='cancelled',updated_at=clock_timestamp() where id=_d.id;
    insert into clinical_private.recording_drafting_events(recording_id,job_id,actor_id,action)
      values(_d.recording_id,_d.id,clinical_private.actor_person_id(),'drafting.cancelled');
  end loop;
  return new;
end $$;

create or replace function clinical_private.admit_recording_cleanup(_recording uuid,_version bigint,_release uuid,_worker_sha256 text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _intent clinical_private.recording_cleanup_intents; _capture clinical_private.encounter_captures;
  _release_row clinical_private.recording_cleanup_releases; _storage clinical_private.recording_storage_releases;
  _policy clinical_private.owned_retention_policies; _actor uuid; _owner uuid; _inventory jsonb; _encounter uuid; _artifacts jsonb;
begin
  _actor:=clinical_private.recording_cleanup_operator(clinical_private.organization_id());
  select c.encounter_id into _encounter from clinical_private.encounter_captures c
    join clinical_private.recording_cleanup_intents i on i.recording_id=c.id
    where c.id=_recording and i.organization_id=clinical_private.organization_id();
  if not found then raise exception using errcode='42501',message='recording_cleanup_operator_required'; end if;
  -- Same encounter-first ordering as capture/lifecycle writers. Do not require
  -- an active chart, active recording consent or an unexpired capture release:
  -- archived/withdrawn recordings still need cleanup, not revived capture rights.
  perform 1 from clinical_core.encounters where id=_encounter for update;
  select * into strict _capture from clinical_private.encounter_captures where id=_recording for no key update;
  select * into strict _intent from clinical_private.recording_cleanup_intents where recording_id=_recording for share;
  perform clinical_private.lock_recording_cleanup_patient(_intent.patient_record_id);
  for _owner in select owner_id from clinical_private.recording_cleanup_subjects where recording_id=_recording order by owner_id loop
    perform pg_advisory_xact_lock(hashtextextended(_owner::text,0));
    if exists(select 1 from clinical_private.owned_legal_holds where owner_id=_owner and released_at is null) then
      raise exception using errcode='42501',message='recording_cleanup_legal_hold'; end if;
  end loop;
  if exists(select 1 from clinical_private.recording_legal_holds where patient_record_id=_intent.patient_record_id and released_at is null) then
    raise exception using errcode='42501',message='recording_cleanup_legal_hold'; end if;
  if _version is null or _version<>_intent.version or _intent.due_at>clock_timestamp()
    or exists(select 1 from clinical_private.recording_segments where recording_id=_recording and accept_before>clock_timestamp())
    -- An open transcription job may still be writing objects; cleanup waits for it to close.
    or exists(select 1 from clinical_private.recording_transcription_jobs where recording_id=_recording and status in ('requested','processing'))
    or exists(select 1 from clinical_private.recording_drafting_jobs where recording_id=_recording and status='requested') then
    raise exception using errcode='55000',message='recording_cleanup_not_ready'; end if;
  select * into _release_row from clinical_private.recording_cleanup_releases where id=_release for share;
  if not found or _release_row.capture_release_id<>_capture.release_id or _release_row.retired_at is not null
    or _release_row.approved_at>clock_timestamp() or _release_row.expires_at<=clock_timestamp()
    or _worker_sha256 is null or _release_row.worker_sha256<>_worker_sha256 then
    raise exception using errcode='42501',message='recording_cleanup_release_required'; end if;
  _policy:=clinical_private.verified_owned_retention_policy(_release_row.retention_policy_version);
  if _policy.content_sha256<>_release_row.retention_policy_sha256 then
    raise exception using errcode='42501',message='recording_cleanup_release_required'; end if;
  select * into strict _storage from clinical_private.recording_storage_releases where id=_release_row.storage_release_id for share;
  if _storage.capture_release_id<>_capture.release_id
    or _storage.configuration_sha256<>encode(public.digest(_storage.configuration::text,'sha256'),'hex')
    or exists(select 1 from clinical_private.recording_segments where recording_id=_recording and storage_release_id<>_storage.id) then
    raise exception using errcode='42501',message='recording_cleanup_release_required'; end if;
  _inventory:=clinical_private.recording_segment_inventory(_recording);
  _artifacts:=clinical_private.recording_transcription_inventory(_recording);
  -- Authorization may have expired while waiting for the encounter/hold locks.
  _actor:=clinical_private.recording_cleanup_operator(_intent.organization_id);
  insert into clinical_private.recording_cleanup_access_events(recording_id,patient_record_id,actor_id,action,release_id,resource_id)
    values(_recording,_intent.patient_record_id,_actor,'cleanup.admitted',_release,_recording);
  return jsonb_build_object('recordingId',_recording,'sessionId',_capture.capture_session_id,'organizationId',_intent.organization_id,'patientRecordId',_intent.patient_record_id,
    'version',_intent.version,'cleanupReleaseId',_release,'workerSha256',_worker_sha256,'storageReleaseId',_storage.id,
    'storage',_storage.configuration,'inventory',_inventory,'inventorySha256',encode(public.digest(_inventory::text,'sha256'),'hex'),
    'transcriptionInventory',_artifacts,'transcriptionInventorySha256',encode(public.digest(_artifacts::text,'sha256'),'hex'),
    'validUntil',least(clock_timestamp()+interval '5 seconds',_release_row.expires_at,
      (select expires_at from clinical_private.recording_cleanup_operators where organization_id=_intent.organization_id and operator_id=_actor)),
    'audioDeleted',false);
end $$;

revoke all on function clinical_private.require_recording_drafting_release(uuid,uuid),clinical_private.owned_drafting_job(uuid) from public,clinical_core_api;
revoke all on function clinical_private.request_recording_drafting(uuid,uuid,uuid,uuid,text),clinical_private.get_recording_drafting_input(uuid),
  clinical_private.fail_recording_drafting(uuid,text),clinical_private.complete_recording_drafting(uuid,text,text,integer,integer,text),
  clinical_private.list_recording_proposed_notes(uuid),clinical_private.get_recording_proposed_note_object(uuid),
  clinical_private.register_recording_drafting_artifact(uuid,text,text,text,integer,uuid) from public;
grant execute on function clinical_private.request_recording_drafting(uuid,uuid,uuid,uuid,text),clinical_private.get_recording_drafting_input(uuid),
  clinical_private.fail_recording_drafting(uuid,text),clinical_private.complete_recording_drafting(uuid,text,text,integer,integer,text),
  clinical_private.list_recording_proposed_notes(uuid),clinical_private.get_recording_proposed_note_object(uuid),
  clinical_private.register_recording_drafting_artifact(uuid,text,text,text,integer,uuid) to clinical_core_api;
