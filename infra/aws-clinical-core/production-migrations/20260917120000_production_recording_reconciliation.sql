-- Reconcile an already reserved object with fresh workforce authority, without
-- recovering a capture token, uploading replacement bytes or reviving consent.
create table clinical_private.recording_reconciliation_events (
  id uuid primary key default gen_random_uuid(),
  recording_id uuid not null references clinical_private.encounter_captures(id),
  segment_id uuid references clinical_private.recording_segments(id),
  actor_id uuid not null references clinical_core.persons(id),
  action text not null check(action in ('inventory.checked','segment.reconciled')),
  created_at timestamptz not null default clock_timestamp()
);
create index recording_reconciliation_events_recording on clinical_private.recording_reconciliation_events(recording_id,created_at,id);
alter table clinical_private.recording_reconciliation_events enable row level security;
alter table clinical_private.recording_reconciliation_events force row level security;
revoke all on clinical_private.recording_reconciliation_events from public,clinical_core_api;
create trigger recording_reconciliation_events_immutable before update or delete on clinical_private.recording_reconciliation_events
  for each row execute function clinical_private.block_update_delete();

create function clinical_private.require_recording_reconciliation(_recording uuid)
returns clinical_private.encounter_captures language plpgsql security definer set search_path='' as $$
declare _r clinical_private.encounter_captures; _e clinical_core.encounters; _epoch bigint; _grants uuid[];
begin
  _r:=clinical_private.lock_owned_recording(_recording);
  select * into _e from clinical_core.encounters where id=_r.encounter_id;
  select authority_epoch into _epoch from clinical_private.recording_controls where encounter_id=_r.encounter_id;
  if _r.status not in ('capturing','paused') or _e.status<>'in_progress'
    or _r.deletion_deadline<=clock_timestamp() or _epoch<>_r.authority_epoch then
    raise exception using errcode='42501',message='recording_capture_refused'; end if;
  _grants:=clinical_private.recording_grants_for_scope(_r.encounter_id,'recording',_r.participant_ids);
  if _grants is distinct from _r.recording_grant_ids then
    raise exception using errcode='42501',message='recording_capture_refused'; end if;
  perform clinical_private.require_recording_capture_release(_r.release_id,_e.organization_id);
  perform clinical_private.require_recording_storage_release(_r.release_id,_e.organization_id);
  return _r;
end $$;

-- Only one unresolved segment is permitted by the reservation path. The
-- immutable source metadata, not browser input, identifies the S3 object.
create function clinical_private.prepare_recording_reconciliation(_recording uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _r clinical_private.encounter_captures; _s clinical_private.recording_segments;
  _storage clinical_private.recording_storage_releases; _p clinical_private.recording_capture_releases; _org uuid;
begin
  _r:=clinical_private.require_recording_reconciliation(_recording);
  select organization_id into _org from clinical_private.recording_controls where encounter_id=_r.encounter_id;
  _storage:=clinical_private.require_recording_storage_release(_r.release_id,_org);
  _p:=clinical_private.require_recording_capture_release(_r.release_id,_org);
  select * into _s from clinical_private.recording_segments where recording_id=_recording and status='reserved' order by sequence limit 1 for update;
  if found then
    if _s.storage_release_id<>_storage.id or _s.authority_epoch<>_r.authority_epoch
      or _s.participant_ids is distinct from _r.participant_ids or _s.recording_grant_ids is distinct from _r.recording_grant_ids then
      raise exception using errcode='40001',message='recording_segment_conflict'; end if;
    update clinical_private.recording_segments set accept_before=least(clock_timestamp()+interval '30 seconds',
      _r.deletion_deadline,_storage.expires_at,_p.expires_at) where id=_s.id returning * into _s;
  end if;
  insert into clinical_private.recording_reconciliation_events(recording_id,segment_id,actor_id,action)
    values(_recording,_s.id,clinical_private.actor_person_id(),'inventory.checked');
  if _s.id is null then return null; end if;
  return jsonb_build_object('segmentId',_s.id,'recordingId',_recording,'sessionId',_r.capture_session_id,'sequence',_s.sequence,
    'sha256',_s.content_sha256,'bytes',_s.byte_length,'authorityEpoch',_s.authority_epoch,'contentType',_r.content_type,
    'status',_s.status,'objectVersion',null,'objectKey',_s.object_key,'acceptBefore',_s.accept_before,'storage',_storage.configuration);
end $$;

-- The server calls only after proving exact version/checksum/length/type/KMS/
-- owner/metadata. Fresh authority is rechecked after the network operation.
create function clinical_private.complete_recording_reconciliation(_recording uuid,_segment uuid,_version text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _r clinical_private.encounter_captures; _s clinical_private.recording_segments;
  _storage clinical_private.recording_storage_releases; _org uuid;
begin
  _r:=clinical_private.require_recording_reconciliation(_recording);
  select organization_id into _org from clinical_private.recording_controls where encounter_id=_r.encounter_id;
  _storage:=clinical_private.require_recording_storage_release(_r.release_id,_org);
  select * into _s from clinical_private.recording_segments where id=_segment and recording_id=_recording for update;
  if not found then raise exception using errcode='42501',message='recording_access_refused'; end if;
  if _s.storage_release_id<>_storage.id or _s.authority_epoch<>_r.authority_epoch
    or _s.participant_ids is distinct from _r.participant_ids or _s.recording_grant_ids is distinct from _r.recording_grant_ids
    or _version is null or _version='null' or length(_version) not between 1 and 1024 or _version !~ '^[A-Za-z0-9+/=._-]+$' then
    raise exception using errcode='40001',message='recording_segment_conflict'; end if;
  if _s.status='stored' then
    if _s.object_version<>_version then raise exception using errcode='40001',message='recording_segment_conflict'; end if;
  else
    if _s.accept_before<=clock_timestamp() then raise exception using errcode='55000',message='recording_reservation_expired'; end if;
    update clinical_private.recording_segments set status='stored',object_version=_version,stored_at=clock_timestamp()
      where id=_segment returning * into _s;
    insert into clinical_private.recording_segment_events(segment_id,actor_id,action,authority_epoch)
      values(_s.id,clinical_private.actor_person_id(),'segment.stored',_r.authority_epoch);
    insert into clinical_private.recording_reconciliation_events(recording_id,segment_id,actor_id,action)
      values(_recording,_s.id,clinical_private.actor_person_id(),'segment.reconciled');
  end if;
  return jsonb_build_object('segmentId',_s.id,'recordingId',_recording,'sequence',_s.sequence,
    'sha256',_s.content_sha256,'bytes',_s.byte_length,'authorityEpoch',_s.authority_epoch,'status','stored');
end $$;
revoke all on function clinical_private.require_recording_reconciliation(uuid) from public,clinical_core_api;
revoke all on function clinical_private.prepare_recording_reconciliation(uuid),
  clinical_private.complete_recording_reconciliation(uuid,uuid,text) from public;
grant execute on function clinical_private.prepare_recording_reconciliation(uuid),
  clinical_private.complete_recording_reconciliation(uuid,uuid,text) to clinical_core_api;
