-- An advisory, short-lived preflight. No capture, token, consent, or approval is
-- created here. Start and every upload still recheck current authority.
create function clinical_private.get_recording_capture_readiness(_encounter uuid,_release uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _e clinical_core.encounters; _p clinical_private.recording_capture_releases;
  _s clinical_private.recording_storage_releases; _participants uuid[]; _epoch bigint; _checked timestamptz;
begin
  _e:=clinical_private.lock_recording_encounter(_encounter);
  if _e.status<>'in_progress' then raise exception using errcode='55000',message='recording_encounter_closed'; end if;
  _p:=clinical_private.require_recording_capture_release(_release,_e.organization_id);
  _s:=clinical_private.require_recording_storage_release(_release,_e.organization_id);
  if exists(select 1 from clinical_private.encounter_captures where encounter_id=_encounter and status<>'closed') then
    raise exception using errcode='55000',message='recording_disposition_required'; end if;
  if not exists(select 1 from clinical_private.recording_participants where encounter_id=_encounter and kind='patient')
    or not exists(select 1 from clinical_private.recording_participants where encounter_id=_encounter and kind='practitioner') then
    raise exception using errcode='55000',message='recording_roster_required'; end if;
  select array_agg(id order by id) into _participants from clinical_private.recording_participants where encounter_id=_encounter;
  perform clinical_private.recording_grants_for_scope(_encounter,'recording',_participants);
  select authority_epoch into _epoch from clinical_private.recording_controls where encounter_id=_encounter;
  _checked:=clock_timestamp();
  return jsonb_build_object('encounterId',_encounter,'ready',true,'authorityEpoch',_epoch,
    'checkedAt',_checked,'expiresAt',least(_checked+interval '30 seconds',_p.expires_at,_s.expires_at),
    'maxRecordingBytes',(_p.configuration->>'maxRecordingBytes')::bigint,
    'maxSegmentBytes',least((_s.configuration->>'maxSegmentBytes')::integer,(_p.configuration->>'maxRecordingBytes')::bigint),
    'maxSegments',4096,'audioRetentionHours',(_p.configuration->>'audioRetentionHours')::integer,
    'contentTypes',jsonb_build_array('audio/webm','audio/ogg','audio/wav','audio/mp4','audio/mpeg'),
    'captureStarted',false,'processingRequested',false);
end $$;
revoke all on function clinical_private.get_recording_capture_readiness(uuid,uuid) from public;
grant execute on function clinical_private.get_recording_capture_readiness(uuid,uuid) to clinical_core_api;
