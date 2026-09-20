-- Production overlay: transcription artifacts (assembled media, provider output,
-- transcript versions) are registered with digest and version so hold-aware
-- cleanup can verify and delete them exactly like audio segments. Cleanup
-- admission waits for open jobs, and enqueuing cleanup cancels them.
create table clinical_private.recording_transcription_artifacts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references clinical_private.recording_transcription_jobs(id),
  recording_id uuid not null references clinical_private.encounter_captures(id),
  kind text not null check(kind in ('media','provider','transcript')),
  object_key text not null unique check(length(object_key) between 1 and 512),
  object_version text not null check(length(object_version) between 1 and 1024 and object_version<>'null' and object_version ~ '^[A-Za-z0-9+/=._-]+$'),
  content_sha256 text not null check(content_sha256 ~ '^[a-f0-9]{64}$'),
  byte_length integer not null check(byte_length between 1 and 268435456),
  transcript_id uuid unique references clinical_private.recording_transcripts(id),
  registered_by uuid not null references clinical_core.persons(id),
  created_at timestamptz not null default clock_timestamp(),
  check((kind='transcript')=(transcript_id is not null))
);
create unique index recording_transcription_artifacts_one_per_kind on clinical_private.recording_transcription_artifacts(job_id,kind) where kind<>'transcript';
create index recording_transcription_artifacts_recording on clinical_private.recording_transcription_artifacts(recording_id,created_at,id);
alter table clinical_private.recording_transcription_artifacts enable row level security;
revoke all on clinical_private.recording_transcription_artifacts from public,clinical_core_api;
create trigger recording_transcription_artifacts_immutable before update or delete on clinical_private.recording_transcription_artifacts
  for each row execute function clinical_private.block_update_delete();

alter table clinical_private.recording_transcription_events drop constraint recording_transcription_events_action_check;
alter table clinical_private.recording_transcription_events add constraint recording_transcription_events_action_check
  check(action in ('transcription.requested','transcription.processing','transcription.completed','transcription.failed',
    'transcription.cancelled','transcript.corrected','transcripts.listed','transcript.read','artifact.registered'));

alter table clinical_private.recording_cleanup_attempts alter column segment_id drop not null;
alter table clinical_private.recording_cleanup_attempts add column artifact_id uuid references clinical_private.recording_transcription_artifacts(id);
alter table clinical_private.recording_cleanup_attempts add constraint recording_cleanup_attempts_one_target check((segment_id is null)<>(artifact_id is null));

-- Registered by the owning workforce actor right after the object exists. The
-- key must sit under the job's transcription prefix and carry the kind's name;
-- a transcript artifact must match its version row exactly. Replays are no-ops.
create function clinical_private.register_recording_transcription_artifact(_job uuid,_kind text,_object_key text,_object_version text,_sha256 text,_bytes integer,_transcript uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _j clinical_private.recording_transcription_jobs; _r clinical_private.encounter_captures; _org uuid; _prefix text; _t clinical_private.recording_transcripts;
  _existing clinical_private.recording_transcription_artifacts; _id uuid;
begin
  _j:=clinical_private.owned_transcription_job(_job);
  select * into _r from clinical_private.encounter_captures where id=_j.recording_id;
  select organization_id into _org from clinical_private.recording_controls where encounter_id=_r.encounter_id;
  _prefix:='encounter-recordings/'||_org||'/'||_j.recording_id||'/transcription/'||_j.id||'/';
  if _kind is null or _kind not in ('media','provider','transcript') or _object_key is null or length(_object_key) not between 1 and 512
    or left(_object_key,length(_prefix))<>_prefix or _object_version is null or length(_object_version) not between 1 and 1024
    or _object_version='null' or _object_version!~'^[A-Za-z0-9+/=._-]+$' or _sha256 is null or _sha256!~'^[a-f0-9]{64}$'
    or _bytes is null or _bytes not between 1 and 268435456
    or (_kind='media' and substr(_object_key,length(_prefix)+1)!~'^media\.(webm|ogg|wav|mp4|mp3)$')
    or (_kind='provider' and substr(_object_key,length(_prefix)+1)<>'provider.json')
    or (_kind='transcript' and substr(_object_key,length(_prefix)+1)!~'^transcript-v[1-9][0-9]*\.txt$')
    or (_kind='transcript')<>(_transcript is not null) then
    raise exception using errcode='22023',message='recording_transcription_artifact_invalid'; end if;
  if _kind='transcript' then
    select * into _t from clinical_private.recording_transcripts where id=_transcript;
    if not found or _t.job_id<>_j.id or _t.object_key<>_object_key or _t.content_sha256<>_sha256 or _t.byte_length<>_bytes then
      raise exception using errcode='22023',message='recording_transcription_artifact_invalid'; end if;
  end if;
  select * into _existing from clinical_private.recording_transcription_artifacts where object_key=_object_key;
  if found then
    if _existing.job_id<>_j.id or _existing.kind<>_kind or _existing.object_version<>_object_version or _existing.content_sha256<>_sha256
      or _existing.byte_length<>_bytes or _existing.transcript_id is distinct from _transcript then
      raise exception using errcode='40001',message='recording_transcription_artifact_conflict'; end if;
    return jsonb_build_object('artifactId',_existing.id,'jobId',_j.id,'kind',_kind,'replayed',true);
  end if;
  if _kind<>'transcript' and exists(select 1 from clinical_private.recording_transcription_artifacts where job_id=_j.id and kind=_kind) then
    raise exception using errcode='40001',message='recording_transcription_artifact_conflict'; end if;
  insert into clinical_private.recording_transcription_artifacts(job_id,recording_id,kind,object_key,object_version,content_sha256,byte_length,transcript_id,registered_by)
    values(_j.id,_j.recording_id,_kind,_object_key,_object_version,_sha256,_bytes,_transcript,clinical_private.actor_person_id()) returning id into _id;
  insert into clinical_private.recording_transcription_events(recording_id,job_id,actor_id,action)
    values(_j.recording_id,_j.id,clinical_private.actor_person_id(),'artifact.registered');
  return jsonb_build_object('artifactId',_id,'jobId',_j.id,'kind',_kind,'replayed',false);
end $$;

create function clinical_private.recording_transcription_inventory(_recording uuid) returns jsonb
language sql security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('artifactId',id,'jobId',job_id,'kind',kind,'objectKey',object_key,'objectVersion',object_version,
    'sha256',content_sha256,'bytes',byte_length,'transcriptId',transcript_id) order by created_at,id),'[]'::jsonb)
  from clinical_private.recording_transcription_artifacts where recording_id=_recording
$$;

-- An actionable cleanup intent (discard, consent revoked, or a retention
-- deadline that has arrived) closes any open transcription job: the processor's
-- next step finds a cancelled job and refuses to write. Completed and failed
-- jobs stay; their artifacts are removed by the cleanup pass itself. A finished
-- recording's future retention intent does not touch a running job.
create function clinical_private.recording_cleanup_cancels_transcription() returns trigger
language plpgsql security definer set search_path='' as $$
declare _j clinical_private.recording_transcription_jobs;
begin
  if new.reason not in ('discard','consent_revoked') and new.due_at>clock_timestamp() then return new; end if;
  for _j in select * from clinical_private.recording_transcription_jobs where recording_id=new.recording_id and status in ('requested','processing') order by id loop
    update clinical_private.recording_transcription_jobs set status='cancelled',updated_at=clock_timestamp() where id=_j.id;
    insert into clinical_private.recording_transcription_events(recording_id,job_id,actor_id,action)
      values(_j.recording_id,_j.id,clinical_private.actor_person_id(),'transcription.cancelled');
  end loop;
  return new;
end $$;
create trigger recording_cleanup_intents_cancel_transcription after insert or update of reason,due_at on clinical_private.recording_cleanup_intents
  for each row execute function clinical_private.recording_cleanup_cancels_transcription();

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
    or exists(select 1 from clinical_private.recording_transcription_jobs where recording_id=_recording and status in ('requested','processing')) then
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

create function clinical_private.prepare_recording_cleanup_artifact_attempt(_recording uuid,_version bigint,_release uuid,_worker text,
  _attempt uuid,_artifact uuid,_object_version text,_kind text,_inventory text,_evidence text) returns uuid
language plpgsql security definer set search_path='' as $$
declare _admission jsonb; _row clinical_private.recording_cleanup_attempts; _actor uuid:=clinical_private.actor_person_id();
begin
  _admission:=clinical_private.admit_recording_cleanup(_recording,_version,_release,_worker);
  if _attempt is null or _artifact is null or _object_version is null or length(_object_version) not between 1 and 1024
    or _object_version='null' or _object_version!~'^[A-Za-z0-9+/=._-]+$' or _kind is null or _kind not in ('object','delete_marker')
    or _inventory is distinct from (_admission->>'inventorySha256') or _evidence is null or _evidence!~'^[a-f0-9]{64}$'
    or not exists(select 1 from clinical_private.recording_transcription_artifacts where id=_artifact and recording_id=_recording) then
    raise exception using errcode='22023',message='recording_cleanup_attempt_invalid'; end if;
  insert into clinical_private.recording_cleanup_attempts(id,recording_id,artifact_id,cleanup_release_id,queue_version,
    inventory_sha256,object_version,object_kind,evidence_sha256,requested_by)
    values(_attempt,_recording,_artifact,_release,_version,_inventory,_object_version,_kind,_evidence,_actor)
    on conflict(id) do nothing;
  select * into strict _row from clinical_private.recording_cleanup_attempts where id=_attempt;
  if _row.recording_id<>_recording or _row.artifact_id is distinct from _artifact or _row.cleanup_release_id<>_release
    or _row.queue_version<>_version or _row.inventory_sha256<>_inventory or _row.object_version<>_object_version
    or _row.object_kind<>_kind or _row.evidence_sha256<>_evidence or _row.requested_by<>_actor then
    raise exception using errcode='55000',message='recording_cleanup_attempt_conflict'; end if;
  return _attempt;
end $$;

create or replace function clinical_private.admit_recording_cleanup_attempt(_recording uuid,_version bigint,_release uuid,_worker text,_attempt uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _admission jsonb; _row clinical_private.recording_cleanup_attempts;
begin
  _admission:=clinical_private.admit_recording_cleanup(_recording,_version,_release,_worker);
  select * into _row from clinical_private.recording_cleanup_attempts where id=_attempt;
  if not found or _row.recording_id<>_recording or _row.queue_version<>_version or _row.cleanup_release_id<>_release
    or _row.inventory_sha256<>(_admission->>'inventorySha256') or _row.requested_by<>clinical_private.actor_person_id() then
    raise exception using errcode='42501',message='recording_cleanup_attempt_required'; end if;
  return _admission||jsonb_build_object('attempt',jsonb_build_object('id',_row.id,'segmentId',_row.segment_id,'artifactId',_row.artifact_id,
    'objectVersion',_row.object_version,'kind',_row.object_kind,'evidenceSha256',_row.evidence_sha256));
end $$;

revoke all on function clinical_private.recording_transcription_inventory(uuid),clinical_private.recording_cleanup_cancels_transcription() from public,clinical_core_api;
revoke all on function clinical_private.register_recording_transcription_artifact(uuid,text,text,text,text,integer,uuid),
  clinical_private.prepare_recording_cleanup_artifact_attempt(uuid,bigint,uuid,text,uuid,uuid,text,text,text,text) from public;
grant execute on function clinical_private.register_recording_transcription_artifact(uuid,text,text,text,text,integer,uuid),
  clinical_private.prepare_recording_cleanup_artifact_attempt(uuid,bigint,uuid,text,uuid,uuid,text,text,text,text) to clinical_core_api;
