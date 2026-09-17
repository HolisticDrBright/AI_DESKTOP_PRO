-- The HTTP start route must qualify storage before the browser may capture.
-- No qualification, destination, consent or activation is seeded here.
create function clinical_private.start_qualified_recording_capture(_encounter uuid,_release uuid,_command uuid,_content_type text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _e clinical_core.encounters; _storage clinical_private.recording_storage_releases;
  _policy clinical_private.recording_capture_releases; _receipt jsonb; _r clinical_private.encounter_captures;
begin
  _e:=clinical_private.lock_recording_encounter(_encounter);
  _policy:=clinical_private.require_recording_capture_release(_release,_e.organization_id);
  _storage:=clinical_private.require_recording_storage_release(_release,_e.organization_id);
  _receipt:=clinical_private.begin_encounter_capture(_encounter,_release,_command,_content_type);
  select * into _r from clinical_private.encounter_captures where id=(_receipt->>'recordingId')::uuid for update;
  if (_receipt->>'replayed')::boolean=false then
    update clinical_private.encounter_captures set token_expires_at=least(token_expires_at,deletion_deadline,_policy.expires_at,_storage.expires_at)
      where id=_r.id returning * into _r;
  end if;
  return jsonb_build_object('recordingId',_r.id,'sessionId',_r.capture_session_id,'encounterId',_encounter,'commandId',_command,
    'contentType',_r.content_type,'status',_r.status,'replayed',(_receipt->>'replayed')::boolean,
    'captureToken',_receipt->>'captureToken','credentialVersion',_r.credential_version,'authorityEpoch',_r.authority_epoch,
    'expiresAt',_r.token_expires_at,'deletionDeadline',_r.deletion_deadline);
end $$;
revoke all on function clinical_private.start_qualified_recording_capture(uuid,uuid,uuid,text) from public;
grant execute on function clinical_private.start_qualified_recording_capture(uuid,uuid,uuid,text) to clinical_core_api;
