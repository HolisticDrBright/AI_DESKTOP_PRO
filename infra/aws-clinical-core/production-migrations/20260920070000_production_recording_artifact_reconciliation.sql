-- Production overlay: the objects a recording's transcription and drafting jobs
-- are expected to have written, minus those already in the artifact registry.
-- A crash between an object write and its registration would otherwise leave
-- cleanup refusing an unknown key forever. Owner-locked read; no text, no
-- storage access, no mutation. Registration still goes through the existing
-- functions, which verify keys, digests and version rows.
create function clinical_private.list_unregistered_recording_objects(_recording uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _r clinical_private.encounter_captures; _org uuid; _ext text;
begin
  _r:=clinical_private.lock_owned_recording(_recording);
  select organization_id into _org from clinical_private.recording_controls where encounter_id=_r.encounter_id;
  _ext:=case _r.content_type when 'audio/webm' then 'webm' when 'audio/ogg' then 'ogg' when 'audio/wav' then 'wav' when 'audio/mp4' then 'mp4' else 'mp3' end;
  return (select coalesce(jsonb_agg(o order by o->>'objectKey'),'[]'::jsonb) from (
    -- Assembled media for every transcription job (written before the job is marked processing).
    select jsonb_build_object('kind','media','jobId',j.id,'objectKey','encounter-recordings/'||_org||'/'||_recording||'/transcription/'||j.id||'/media.'||_ext,
        'sha256',null,'bytes',null,'transcriptId',null,'proposedNoteId',null) as o
      from clinical_private.recording_transcription_jobs j where j.recording_id=_recording
        and not exists(select 1 from clinical_private.recording_transcription_artifacts a where a.job_id=j.id and a.kind='media')
    union all
    -- Provider output for jobs whose provider job was started.
    select jsonb_build_object('kind','provider','jobId',j.id,'objectKey','encounter-recordings/'||_org||'/'||_recording||'/transcription/'||j.id||'/provider.json',
        'sha256',null,'bytes',null,'transcriptId',null,'proposedNoteId',null)
      from clinical_private.recording_transcription_jobs j where j.recording_id=_recording and j.provider_job_name is not null
        and not exists(select 1 from clinical_private.recording_transcription_artifacts a where a.job_id=j.id and a.kind='provider')
    union all
    -- Transcript versions whose row exists but whose object was never registered.
    select jsonb_build_object('kind','transcript','jobId',t.job_id,'objectKey',t.object_key,'sha256',t.content_sha256,'bytes',t.byte_length,'transcriptId',t.id,'proposedNoteId',null)
      from clinical_private.recording_transcripts t where t.recording_id=_recording
        and not exists(select 1 from clinical_private.recording_transcription_artifacts a where a.transcript_id=t.id)
    union all
    select jsonb_build_object('kind','proposed_note','jobId',n.job_id,'objectKey',n.object_key,'sha256',n.content_sha256,'bytes',n.byte_length,'transcriptId',null,'proposedNoteId',n.id)
      from clinical_private.recording_proposed_notes n where n.recording_id=_recording
        and not exists(select 1 from clinical_private.recording_transcription_artifacts a where a.proposed_note_id=n.id)
  ) x);
end $$;
revoke all on function clinical_private.list_unregistered_recording_objects(uuid) from public;
grant execute on function clinical_private.list_unregistered_recording_objects(uuid) to clinical_core_api;
