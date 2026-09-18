-- Recoverable control commands; no provider work, deletion or activation seeds.
alter table clinical_private.encounter_captures add column credential_version bigint not null default 0
  check(credential_version between 0 and 9007199254740991);
create table clinical_private.recording_lifecycle_commands (
  recording_id uuid not null references clinical_private.encounter_captures(id),
  command_id uuid not null,
  actor_id uuid not null references clinical_core.persons(id),
  request_sha256 text not null check(request_sha256 ~ '^[a-f0-9]{64}$'),
  receipt jsonb not null check(jsonb_typeof(receipt)='object' and not receipt ? 'captureToken'),
  created_at timestamptz not null default clock_timestamp(),
  primary key(recording_id,command_id)
);
create table clinical_private.recording_dispositions (
  recording_id uuid primary key references clinical_private.encounter_captures(id),
  actor_id uuid not null references clinical_core.persons(id),
  disposition text not null check(disposition in ('finish','discard')),
  inventory_sha256 text not null check(inventory_sha256 ~ '^[a-f0-9]{64}$'),
  inventory jsonb not null check(jsonb_typeof(inventory)='array'),
  created_at timestamptz not null default clock_timestamp()
);
create table clinical_private.recording_lifecycle_events (
  id uuid primary key default gen_random_uuid(),
  recording_id uuid not null references clinical_private.encounter_captures(id),
  actor_id uuid not null references clinical_core.persons(id),
  action text not null check(action in ('state.read','pause','resume','renew','finish','discard')),
  credential_version bigint not null,
  created_at timestamptz not null default clock_timestamp()
);
create index recording_lifecycle_events_capture on clinical_private.recording_lifecycle_events(recording_id,created_at,id);
alter table clinical_private.recording_lifecycle_commands enable row level security;
alter table clinical_private.recording_lifecycle_commands force row level security;
alter table clinical_private.recording_dispositions enable row level security;
alter table clinical_private.recording_dispositions force row level security;
alter table clinical_private.recording_lifecycle_events enable row level security;
alter table clinical_private.recording_lifecycle_events force row level security;
revoke all on clinical_private.recording_lifecycle_commands,clinical_private.recording_dispositions,
  clinical_private.recording_lifecycle_events from public,clinical_core_api;
create trigger recording_lifecycle_commands_immutable before update or delete on clinical_private.recording_lifecycle_commands
  for each row execute function clinical_private.block_update_delete();
create trigger recording_dispositions_immutable before update or delete on clinical_private.recording_dispositions
  for each row execute function clinical_private.block_update_delete();
create trigger recording_lifecycle_events_immutable before update or delete on clinical_private.recording_lifecycle_events
  for each row execute function clinical_private.block_update_delete();

-- Caller must first take the encounter lock. No token or participant name is in
-- this immutable byte/version inventory; keys remain server-private.
create function clinical_private.recording_segment_inventory(_recording uuid) returns jsonb
language sql security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('segmentId',id,'sequence',sequence,'sha256',content_sha256,
    'bytes',byte_length,'status',status,'objectKey',object_key,'objectVersion',object_version,
    'storageReleaseId',storage_release_id,'authorityEpoch',authority_epoch,'participantIds',participant_ids,
    'recordingGrantIds',recording_grant_ids) order by sequence),'[]'::jsonb)
  from clinical_private.recording_segments where recording_id=_recording
$$;
create function clinical_private.lock_owned_recording(_recording uuid)
returns clinical_private.encounter_captures language plpgsql security definer set search_path='' as $$
declare _r clinical_private.encounter_captures;
begin
  select * into _r from clinical_private.encounter_captures where id=_recording;
  if not found then raise exception using errcode='42501',message='recording_access_refused'; end if;
  perform clinical_private.lock_recording_encounter(_r.encounter_id);
  select * into _r from clinical_private.encounter_captures where id=_recording for update;
  if _r.created_by<>clinical_private.actor_person_id() then
    raise exception using errcode='42501',message='recording_access_refused'; end if;
  return _r;
end $$;
create function clinical_private.get_recording_recovery_state(_recording uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _r clinical_private.encounter_captures; _inventory jsonb; _disposition text;
  _stored integer; _pending integer; _total bigint; _epoch bigint;
begin
  _r:=clinical_private.lock_owned_recording(_recording);
  _inventory:=clinical_private.recording_segment_inventory(_recording);
  select count(*) filter(where status='stored'),count(*) filter(where status='reserved'),coalesce(sum(byte_length),0)
    into _stored,_pending,_total from clinical_private.recording_segments where recording_id=_recording;
  select authority_epoch into _epoch from clinical_private.recording_controls where encounter_id=_r.encounter_id;
  select disposition into _disposition from clinical_private.recording_dispositions where recording_id=_recording;
  insert into clinical_private.recording_lifecycle_events(recording_id,actor_id,action,credential_version)
    values(_recording,clinical_private.actor_person_id(),'state.read',_r.credential_version);
  return jsonb_build_object('recordingId',_recording,'sessionId',_r.capture_session_id,'status',_r.status,
    'credentialVersion',_r.credential_version,'authorityEpoch',_r.authority_epoch,'currentAuthorityEpoch',_epoch,
    'tokenExpiresAt',_r.token_expires_at,'deletionDeadline',_r.deletion_deadline,
    'storedSegments',_stored,'pendingSegments',_pending,'reservedBytes',_total,'nextSequence',_stored+_pending,
    'inventorySha256',encode(public.digest(_inventory::text,'sha256'),'hex'),'disposition',_disposition,
    'processingRequested',false,'audioDeleted',false);
end $$;

-- Requires fresh verified workforce context in the API, never possession of an
-- old audio token alone. Compare-and-swap prevents two devices silently sharing
-- control. A replay returns a secret-free historical receipt, never a new token.
create function clinical_private.command_recording_lifecycle(_recording uuid,_command uuid,_action text,
  _expected_version bigint,_inventory_sha256 text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _r clinical_private.encounter_captures; _prior clinical_private.recording_lifecycle_commands;
  _e clinical_core.encounters; _request_hash text; _receipt jsonb; _inventory jsonb; _actual_hash text;
  _token text; _epoch bigint; _grants uuid[]; _stored integer; _pending integer;
  _p clinical_private.recording_capture_releases; _storage clinical_private.recording_storage_releases;
begin
  _r:=clinical_private.lock_owned_recording(_recording);
  select * into _e from clinical_core.encounters where id=_r.encounter_id;
  if _command is null or _action is null or _action not in ('pause','resume','renew','finish','discard')
    or _expected_version is null or _expected_version not between 0 and 9007199254740990
    or (_action in ('finish','discard') and (_inventory_sha256 is null or _inventory_sha256 !~ '^[a-f0-9]{64}$'))
    or (_action not in ('finish','discard') and _inventory_sha256 is not null) then
    raise exception using errcode='22023',message='recording_lifecycle_invalid'; end if;
  _request_hash:=encode(public.digest(jsonb_build_object('action',_action,'expectedVersion',_expected_version,'inventorySha256',_inventory_sha256)::text,'sha256'),'hex');
  select * into _prior from clinical_private.recording_lifecycle_commands where recording_id=_recording and command_id=_command;
  if found then
    if _prior.actor_id<>clinical_private.actor_person_id() or _prior.request_sha256<>_request_hash then
      raise exception using errcode='40001',message='recording_lifecycle_conflict'; end if;
    return _prior.receipt||jsonb_build_object('replayed',true,'captureToken',null,'requiresCredentialRecovery',_action in ('resume','renew'));
  end if;
  if _r.credential_version<>_expected_version or _r.status='closed' then
    raise exception using errcode='40001',message='recording_lifecycle_conflict'; end if;
  if _action='pause' then
    if _r.status<>'capturing' then raise exception using errcode='40001',message='recording_lifecycle_conflict'; end if;
    update clinical_private.encounter_captures set status='paused',token_expires_at=clock_timestamp(),credential_version=credential_version+1
      where id=_recording returning * into _r;
  elsif _action in ('resume','renew') then
    if _e.status<>'in_progress' or _r.deletion_deadline<=clock_timestamp()
      or (_action='resume' and _r.status<>'paused') or (_action='renew' and _r.status<>'capturing') then
      raise exception using errcode='42501',message='recording_capture_refused'; end if;
    select authority_epoch into _epoch from clinical_private.recording_controls where encounter_id=_r.encounter_id;
    if _epoch<>_r.authority_epoch then raise exception using errcode='55000',message='recording_disposition_required'; end if;
    _grants:=clinical_private.recording_grants_for_scope(_r.encounter_id,'recording',_r.participant_ids);
    if _grants is distinct from _r.recording_grant_ids then raise exception using errcode='42501',message='recording_capture_refused'; end if;
    _p:=clinical_private.require_recording_capture_release(_r.release_id,_e.organization_id);
    _storage:=clinical_private.require_recording_storage_release(_r.release_id,_e.organization_id);
    _token:=encode(public.gen_random_bytes(32),'hex');
    update clinical_private.encounter_captures set status='capturing',token_sha256=encode(public.digest(_token,'sha256'),'hex'),
      token_expires_at=least(clock_timestamp()+interval '120 seconds',deletion_deadline,_p.expires_at,_storage.expires_at),
      credential_version=credential_version+1,last_authorized_at=clock_timestamp() where id=_recording returning * into _r;
  else
    _inventory:=clinical_private.recording_segment_inventory(_recording);
    _actual_hash:=encode(public.digest(_inventory::text,'sha256'),'hex');
    if _actual_hash<>_inventory_sha256 then raise exception using errcode='40001',message='recording_inventory_changed'; end if;
    if _action='finish' then
      if _r.status='revoked' then raise exception using errcode='42501',message='recording_capture_refused'; end if;
      _grants:=clinical_private.recording_grants_for_scope(_r.encounter_id,'recording',_r.participant_ids);
      if _grants is distinct from _r.recording_grant_ids then raise exception using errcode='42501',message='recording_capture_refused'; end if;
      select count(*) filter(where status='stored'),count(*) filter(where status='reserved') into _stored,_pending
        from clinical_private.recording_segments where recording_id=_recording;
      if _stored=0 or _pending<>0 then raise exception using errcode='55000',message='recording_segments_unresolved'; end if;
    end if;
    insert into clinical_private.recording_dispositions(recording_id,actor_id,disposition,inventory_sha256,inventory)
      values(_recording,clinical_private.actor_person_id(),_action,_actual_hash,_inventory);
    update clinical_private.encounter_captures set status='closed',token_expires_at=clock_timestamp(),credential_version=credential_version+1
      where id=_recording returning * into _r;
  end if;
  _receipt:=jsonb_build_object('recordingId',_recording,'commandId',_command,'action',_action,'statusAtCommand',_r.status,
    'credentialVersion',_r.credential_version,'expiresAt',_r.token_expires_at,'inventorySha256',_inventory_sha256,
    'processingRequested',false,'audioDeleted',false);
  insert into clinical_private.recording_lifecycle_commands(recording_id,command_id,actor_id,request_sha256,receipt)
    values(_recording,_command,clinical_private.actor_person_id(),_request_hash,_receipt);
  insert into clinical_private.recording_lifecycle_events(recording_id,actor_id,action,credential_version)
    values(_recording,clinical_private.actor_person_id(),_action,_r.credential_version);
  return _receipt||jsonb_build_object('replayed',false,'captureToken',_token,'requiresCredentialRecovery',false);
end $$;
revoke all on function clinical_private.recording_segment_inventory(uuid),clinical_private.lock_owned_recording(uuid) from public,clinical_core_api;
revoke all on function clinical_private.get_recording_recovery_state(uuid),
  clinical_private.command_recording_lifecycle(uuid,uuid,text,bigint,text) from public;
grant execute on function clinical_private.get_recording_recovery_state(uuid),
  clinical_private.command_recording_lifecycle(uuid,uuid,text,bigint,text) to clinical_core_api;
