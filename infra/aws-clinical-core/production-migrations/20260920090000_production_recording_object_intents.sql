-- Production overlay: recovery for interrupted recording steps. Every object a
-- processor is about to write, or expects a provider to write, is declared
-- first (job, kind, key, expected digest and size when known). Reconciliation
-- lists declared or expected objects without artifact rows, including those
-- whose result row was never created, and may register such an object as an
-- 'orphan' artifact so hold-aware cleanup removes it. Storage coordinates for
-- reconciliation come from the recording itself, not from a transcript.
create table clinical_private.recording_object_intents (
  id uuid primary key default gen_random_uuid(),
  recording_id uuid not null references clinical_private.encounter_captures(id),
  job_id uuid references clinical_private.recording_transcription_jobs(id),
  drafting_job_id uuid references clinical_private.recording_drafting_jobs(id),
  kind text not null check(kind in ('media','provider','transcript','proposed_note')),
  object_key text not null unique check(length(object_key) between 1 and 512),
  content_sha256 text check(content_sha256 ~ '^[a-f0-9]{64}$'),
  byte_length integer check(byte_length between 1 and 268435456),
  declared_by uuid not null references clinical_core.persons(id),
  declared_at timestamptz not null default clock_timestamp(),
  check((job_id is null)<>(drafting_job_id is null)),
  check((drafting_job_id is null) or kind='proposed_note')
);
create index recording_object_intents_recording on clinical_private.recording_object_intents(recording_id,declared_at,id);
alter table clinical_private.recording_object_intents enable row level security;
revoke all on clinical_private.recording_object_intents from public,clinical_core_api;
create trigger recording_object_intents_immutable before update or delete on clinical_private.recording_object_intents
  for each row execute function clinical_private.block_update_delete();

alter table clinical_private.recording_transcription_artifacts drop constraint recording_transcription_artifacts_kind_check;
alter table clinical_private.recording_transcription_artifacts add constraint recording_transcription_artifacts_kind_check
  check(kind in ('media','provider','transcript','proposed_note','orphan'));
alter table clinical_private.recording_transcription_artifacts drop constraint recording_transcription_artifacts_drafting_kind;
alter table clinical_private.recording_transcription_artifacts add constraint recording_transcription_artifacts_drafting_kind
  check((drafting_job_id is null) or kind in ('proposed_note','orphan'));
alter table clinical_private.recording_transcription_events drop constraint recording_transcription_events_action_check;
alter table clinical_private.recording_transcription_events add constraint recording_transcription_events_action_check
  check(action in ('transcription.requested','transcription.processing','transcription.completed','transcription.failed',
    'transcription.cancelled','transcript.corrected','transcripts.listed','transcript.read','artifact.registered','object.declared','orphan.registered'));

create function clinical_private.recording_object_prefix(_recording uuid,_job uuid,_drafting boolean) returns text
language plpgsql stable security definer set search_path='' as $$
declare _org uuid;
begin
  select c.organization_id into _org from clinical_private.encounter_captures e join clinical_private.recording_controls c on c.encounter_id=e.encounter_id where e.id=_recording;
  return 'encounter-recordings/'||_org||'/'||_recording||'/'||case when _drafting then 'drafting' else 'transcription' end||'/'||_job||'/';
end $$;

-- Declared by the owning workforce actor before the write or provider start. Idempotent on the key.
create function clinical_private.declare_recording_object(_job uuid,_drafting boolean,_kind text,_object_key text,_sha256 text,_bytes integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _recording uuid; _prefix text; _existing clinical_private.recording_object_intents; _id uuid;
begin
  if _drafting then _recording:=(clinical_private.owned_drafting_job(_job)).recording_id;
  else _recording:=(clinical_private.owned_transcription_job(_job)).recording_id; end if;
  _prefix:=clinical_private.recording_object_prefix(_recording,_job,_drafting);
  if _kind is null or _kind not in ('media','provider','transcript','proposed_note') or (_drafting and _kind<>'proposed_note') or (not _drafting and _kind='proposed_note')
    or _object_key is null or left(_object_key,length(_prefix))<>_prefix or length(_object_key)>512
    or (_sha256 is not null and _sha256!~'^[a-f0-9]{64}$') or (_bytes is not null and _bytes not between 1 and 268435456) then
    raise exception using errcode='22023',message='recording_transcription_artifact_invalid'; end if;
  select * into _existing from clinical_private.recording_object_intents where object_key=_object_key;
  if found then
    if _existing.recording_id<>_recording or _existing.kind<>_kind or (_existing.content_sha256 is not null and _sha256 is not null and _existing.content_sha256<>_sha256) then
      raise exception using errcode='40001',message='recording_transcription_artifact_conflict'; end if;
    return jsonb_build_object('intentId',_existing.id,'replayed',true);
  end if;
  insert into clinical_private.recording_object_intents(recording_id,job_id,drafting_job_id,kind,object_key,content_sha256,byte_length,declared_by)
    values(_recording,case when _drafting then null else _job end,case when _drafting then _job else null end,_kind,_object_key,_sha256,_bytes,clinical_private.actor_person_id()) returning id into _id;
  insert into clinical_private.recording_transcription_events(recording_id,job_id,actor_id,action)
    values(_recording,case when _drafting then null else _job end,clinical_private.actor_person_id(),'object.declared');
  return jsonb_build_object('intentId',_id,'replayed',false);
end $$;

-- Storage coordinates for reconciliation without a transcript: the capture's storage release.
create function clinical_private.get_recording_storage(_recording uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _r clinical_private.encounter_captures; _org uuid; _storage clinical_private.recording_storage_releases;
begin
  _r:=clinical_private.lock_owned_recording(_recording);
  select organization_id into _org from clinical_private.recording_controls where encounter_id=_r.encounter_id;
  _storage:=clinical_private.require_recording_storage_release(_r.release_id,_org);
  return jsonb_build_object('recordingId',_recording,'organizationId',_org,'storage',_storage.configuration);
end $$;

-- A declared object that exists in storage but has no result row becomes an orphan artifact so cleanup removes it.
create function clinical_private.register_recording_orphan_artifact(_object_key text,_object_version text,_sha256 text,_bytes integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _intent clinical_private.recording_object_intents; _existing clinical_private.recording_transcription_artifacts; _id uuid; _job uuid;
begin
  select * into _intent from clinical_private.recording_object_intents where object_key=_object_key;
  if not found then raise exception using errcode='22023',message='recording_transcription_artifact_invalid'; end if;
  perform clinical_private.lock_owned_recording(_intent.recording_id);
  if _object_version is null or length(_object_version) not between 1 and 1024 or _object_version='null' or _object_version!~'^[A-Za-z0-9+/=._-]+$'
    or _sha256 is null or _sha256!~'^[a-f0-9]{64}$' or _bytes is null or _bytes not between 1 and 268435456
    or (_intent.content_sha256 is not null and _intent.content_sha256<>_sha256) or (_intent.byte_length is not null and _intent.byte_length<>_bytes) then
    raise exception using errcode='22023',message='recording_transcription_artifact_invalid'; end if;
  -- A result row for this key means the ordinary registration applies, not the orphan path.
  if exists(select 1 from clinical_private.recording_transcripts where object_key=_object_key)
    or exists(select 1 from clinical_private.recording_proposed_notes where object_key=_object_key) then
    raise exception using errcode='40001',message='recording_transcription_artifact_conflict'; end if;
  select * into _existing from clinical_private.recording_transcription_artifacts where object_key=_object_key;
  if found then
    if _existing.object_version<>_object_version or _existing.content_sha256<>_sha256 or _existing.byte_length<>_bytes then
      raise exception using errcode='40001',message='recording_transcription_artifact_conflict'; end if;
    return jsonb_build_object('artifactId',_existing.id,'jobId',coalesce(_existing.job_id,_existing.drafting_job_id),'kind',_existing.kind,'replayed',true);
  end if;
  _job:=coalesce(_intent.job_id,_intent.drafting_job_id);
  insert into clinical_private.recording_transcription_artifacts(job_id,drafting_job_id,recording_id,kind,object_key,object_version,content_sha256,byte_length,registered_by)
    values(_intent.job_id,_intent.drafting_job_id,_intent.recording_id,case when _intent.kind in ('media','provider') then _intent.kind else 'orphan' end,
      _object_key,_object_version,_sha256,_bytes,clinical_private.actor_person_id()) returning id into _id;
  insert into clinical_private.recording_transcription_events(recording_id,job_id,actor_id,action)
    values(_intent.recording_id,_intent.job_id,clinical_private.actor_person_id(),'orphan.registered');
  return jsonb_build_object('artifactId',_id,'jobId',_job,'kind',case when _intent.kind in ('media','provider') then _intent.kind else 'orphan' end,'replayed',false);
end $$;

-- Expected objects: declared intents, plus result rows and expected provider output, minus registered artifacts.
create or replace function clinical_private.list_unregistered_recording_objects(_recording uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _r clinical_private.encounter_captures; _org uuid; _ext text;
begin
  _r:=clinical_private.lock_owned_recording(_recording);
  select organization_id into _org from clinical_private.recording_controls where encounter_id=_r.encounter_id;
  _ext:=case _r.content_type when 'audio/webm' then 'webm' when 'audio/ogg' then 'ogg' when 'audio/wav' then 'wav' when 'audio/mp4' then 'mp4' else 'mp3' end;
  return (select coalesce(jsonb_agg(o order by o->>'objectKey'),'[]'::jsonb) from (
    select distinct on (x->>'objectKey') x as o from (
      select jsonb_build_object('kind','media','jobId',j.id,'objectKey','encounter-recordings/'||_org||'/'||_recording||'/transcription/'||j.id||'/media.'||_ext,
          'sha256',null,'bytes',null,'transcriptId',null,'proposedNoteId',null,'declared',false) as x
        from clinical_private.recording_transcription_jobs j where j.recording_id=_recording
      union all
      select jsonb_build_object('kind','provider','jobId',j.id,'objectKey','encounter-recordings/'||_org||'/'||_recording||'/transcription/'||j.id||'/provider.json',
          'sha256',null,'bytes',null,'transcriptId',null,'proposedNoteId',null,'declared',false)
        from clinical_private.recording_transcription_jobs j where j.recording_id=_recording and j.provider_job_name is not null
      union all
      select jsonb_build_object('kind','transcript','jobId',t.job_id,'objectKey',t.object_key,'sha256',t.content_sha256,'bytes',t.byte_length,'transcriptId',t.id,'proposedNoteId',null,'declared',false)
        from clinical_private.recording_transcripts t where t.recording_id=_recording
      union all
      select jsonb_build_object('kind','proposed_note','jobId',n.job_id,'objectKey',n.object_key,'sha256',n.content_sha256,'bytes',n.byte_length,'transcriptId',null,'proposedNoteId',n.id,'declared',false)
        from clinical_private.recording_proposed_notes n where n.recording_id=_recording
      union all
      -- Declared objects with no result row: registered as orphans when they exist.
      select jsonb_build_object('kind',case when i.kind in ('media','provider') then i.kind else 'orphan' end,'jobId',coalesce(i.job_id,i.drafting_job_id),'objectKey',i.object_key,
          'sha256',i.content_sha256,'bytes',i.byte_length,'transcriptId',null,'proposedNoteId',null,'declared',true)
        from clinical_private.recording_object_intents i where i.recording_id=_recording
          and not exists(select 1 from clinical_private.recording_transcripts t where t.object_key=i.object_key)
          and not exists(select 1 from clinical_private.recording_proposed_notes n where n.object_key=i.object_key)
    ) y where not exists(select 1 from clinical_private.recording_transcription_artifacts a where a.object_key=x->>'objectKey')
    order by x->>'objectKey',(x->>'declared')::boolean desc
  ) z);
end $$;

revoke all on function clinical_private.recording_object_prefix(uuid,uuid,boolean) from public,clinical_core_api;
revoke all on function clinical_private.declare_recording_object(uuid,boolean,text,text,text,integer),clinical_private.get_recording_storage(uuid),
  clinical_private.register_recording_orphan_artifact(text,text,text,integer) from public;
grant execute on function clinical_private.declare_recording_object(uuid,boolean,text,text,text,integer),clinical_private.get_recording_storage(uuid),
  clinical_private.register_recording_orphan_artifact(text,text,text,integer) to clinical_core_api;
