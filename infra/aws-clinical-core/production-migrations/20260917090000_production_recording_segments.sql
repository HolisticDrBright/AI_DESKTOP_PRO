-- Durable upload reservations and consent-bound receipts. No storage/provider
-- approvals are seeded. Reserved objects are NOT accepted or processable audio.
create table clinical_private.recording_storage_releases (
  id uuid primary key default gen_random_uuid(),
  capture_release_id uuid not null unique references clinical_private.recording_capture_releases(id),
  configuration jsonb not null check(jsonb_typeof(configuration)='object'),
  configuration_sha256 text not null check(configuration_sha256 ~ '^[a-f0-9]{64}$'),
  qualification_sha256 text not null check(qualification_sha256 ~ '^[a-f0-9]{64}$'),
  approved_by text not null check(length(btrim(approved_by)) between 1 and 200),
  approved_at timestamptz not null,
  expires_at timestamptz not null,
  retired_at timestamptz,
  check(expires_at>approved_at)
);
create table clinical_private.recording_segments (
  id uuid primary key default gen_random_uuid(),
  recording_id uuid not null references clinical_private.encounter_captures(id),
  storage_release_id uuid not null references clinical_private.recording_storage_releases(id),
  sequence integer not null check(sequence between 0 and 4095),
  content_sha256 text not null check(content_sha256 ~ '^[a-f0-9]{64}$'),
  byte_length integer not null check(byte_length between 1 and 4194304),
  object_key text not null unique,
  participant_ids uuid[] not null check(cardinality(participant_ids)>0),
  recording_grant_ids uuid[] not null check(cardinality(recording_grant_ids)>0),
  authority_epoch bigint not null,
  status text not null default 'reserved' check(status in ('reserved','stored')),
  reserved_at timestamptz not null default clock_timestamp(),
  accept_before timestamptz not null,
  object_version text,
  stored_at timestamptz,
  unique(recording_id,sequence),
  check((status='reserved' and object_version is null and stored_at is null)
    or (status='stored' and length(object_version) between 1 and 1024 and object_version<>'null' and stored_at is not null))
);
-- Pending reservations are the durable inventory for reconciliation/cleanup;
-- missing completion must never be interpreted as absence of an S3 object.
create index recording_segments_pending on clinical_private.recording_segments(accept_before,id) where status='reserved';
create table clinical_private.recording_segment_events (
  id uuid primary key default gen_random_uuid(),
  segment_id uuid not null references clinical_private.recording_segments(id),
  actor_id uuid not null references clinical_core.persons(id),
  action text not null check(action in ('segment.reserved','segment.stored')),
  authority_epoch bigint not null,
  created_at timestamptz not null default clock_timestamp()
);
create index recording_segment_events_segment on clinical_private.recording_segment_events(segment_id,created_at,id);
alter table clinical_private.recording_storage_releases enable row level security;
alter table clinical_private.recording_storage_releases force row level security;
alter table clinical_private.recording_segments enable row level security;
alter table clinical_private.recording_segments force row level security;
alter table clinical_private.recording_segment_events enable row level security;
alter table clinical_private.recording_segment_events force row level security;
revoke all on clinical_private.recording_storage_releases,clinical_private.recording_segments,
  clinical_private.recording_segment_events from public,clinical_core_api;
create trigger recording_storage_release_immutable before update or delete on clinical_private.recording_storage_releases
  for each row execute function clinical_private.guard_recording_release_update();
create trigger recording_segment_events_immutable before update or delete on clinical_private.recording_segment_events
  for each row execute function clinical_private.block_update_delete();

create function clinical_private.guard_recording_segment_update() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op='DELETE' or old.status='stored'
    or (to_jsonb(new)-array['accept_before','status','object_version','stored_at'])
      is distinct from (to_jsonb(old)-array['accept_before','status','object_version','stored_at']) then
    raise exception using errcode='55000',message='recording_segment_immutable'; end if;
  return new;
end $$;
create trigger recording_segment_provenance_immutable before update or delete on clinical_private.recording_segments
  for each row execute function clinical_private.guard_recording_segment_update();

create function clinical_private.require_recording_storage_release(_capture_release uuid,_org uuid)
returns clinical_private.recording_storage_releases language plpgsql security definer set search_path='' as $$
declare _r clinical_private.recording_storage_releases; _p clinical_private.recording_capture_releases; _keys text[];
begin
  _p:=clinical_private.require_recording_capture_release(_capture_release,_org);
  select * into _r from clinical_private.recording_storage_releases where capture_release_id=_capture_release
    and retired_at is null and approved_at<=clock_timestamp() and expires_at>clock_timestamp()
    and configuration_sha256=encode(public.digest(configuration::text,'sha256'),'hex') for share;
  if not found then raise exception using errcode='55000',message='recording_storage_release_required'; end if;
  select array_agg(k order by k) into _keys from jsonb_object_keys(_r.configuration) k;
  if _keys is distinct from array['bucket','expectedBucketOwner','kmsKeyArn','maxSegmentBytes','region']
    or jsonb_typeof(_r.configuration->'bucket') is distinct from 'string'
    or coalesce(_r.configuration->>'bucket','') !~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'
    or jsonb_typeof(_r.configuration->'expectedBucketOwner') is distinct from 'string'
    or coalesce(_r.configuration->>'expectedBucketOwner','') !~ '^[0-9]{12}$'
    or jsonb_typeof(_r.configuration->'region') is distinct from 'string'
    or (_r.configuration->>'region') is distinct from (_p.configuration->>'region')
    or jsonb_typeof(_r.configuration->'kmsKeyArn') is distinct from 'string'
    or coalesce(_r.configuration->>'kmsKeyArn','') !~ ('^arn:aws:kms:'||(_p.configuration->>'region')||':'||(_r.configuration->>'expectedBucketOwner')||':key/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
    or jsonb_typeof(_r.configuration->'maxSegmentBytes') is distinct from 'number'
    or coalesce(_r.configuration->>'maxSegmentBytes','') !~ '^[0-9]+$' then
    raise exception using errcode='55000',message='recording_storage_release_required'; end if;
  if (_r.configuration->>'maxSegmentBytes')::numeric not between 1 and 4194304 then
    raise exception using errcode='55000',message='recording_storage_release_required'; end if;
  return _r;
end $$;

-- Locks follow the existing encounter -> capture order. The transaction returns
-- before the service performs any S3 network request.
create function clinical_private.reserve_recording_segment(_recording uuid,_session uuid,_token text,
  _sequence integer,_sha256 text,_bytes integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _r clinical_private.encounter_captures; _s clinical_private.recording_segments;
  _storage clinical_private.recording_storage_releases; _p clinical_private.recording_capture_releases;
  _org uuid; _total bigint; _next integer;
begin
  perform clinical_private.authorize_encounter_capture(_recording,_session,_token,'recording');
  select * into _r from clinical_private.encounter_captures where id=_recording;
  select organization_id into _org from clinical_private.recording_controls where encounter_id=_r.encounter_id;
  _storage:=clinical_private.require_recording_storage_release(_r.release_id,_org);
  _p:=clinical_private.require_recording_capture_release(_r.release_id,_org);
  if _sequence is null or _sequence not between 0 and 4095 or _sha256 is null or _sha256 !~ '^[a-f0-9]{64}$'
    or _bytes is null or _bytes not between 1 and (_storage.configuration->>'maxSegmentBytes')::integer then
    raise exception using errcode='22023',message='recording_segment_invalid'; end if;
  select * into _s from clinical_private.recording_segments where recording_id=_recording and sequence=_sequence;
  if found then
    if _s.content_sha256<>_sha256 or _s.byte_length<>_bytes or _s.authority_epoch<>_r.authority_epoch
      or _s.storage_release_id<>_storage.id then
      raise exception using errcode='40001',message='recording_segment_conflict'; end if;
    if _s.status='reserved' then
      -- Same content/key on retry; a new consent epoch cannot renew an old chunk.
      update clinical_private.recording_segments set accept_before=least(clock_timestamp()+interval '30 seconds',
        _r.token_expires_at,_r.deletion_deadline,_storage.expires_at,_p.expires_at) where id=_s.id returning * into _s;
    end if;
  else
    select coalesce(sum(byte_length),0),coalesce(max(sequence)+1,0) into _total,_next
      from clinical_private.recording_segments where recording_id=_recording;
    if _sequence<>_next or exists(select 1 from clinical_private.recording_segments where recording_id=_recording and status='reserved') then
      raise exception using errcode='40001',message='recording_segment_order_required'; end if;
    if _total+_bytes>(_p.configuration->>'maxRecordingBytes')::bigint then
      raise exception using errcode='22023',message='recording_size_limit'; end if;
    insert into clinical_private.recording_segments(recording_id,storage_release_id,sequence,content_sha256,byte_length,object_key,
      participant_ids,recording_grant_ids,authority_epoch,accept_before)
      values(_recording,_storage.id,_sequence,_sha256,_bytes,
        'encounter-recordings/'||_org||'/'||_recording||'/'||_session||'/'||_sequence||'-'||_sha256,
        _r.participant_ids,_r.recording_grant_ids,_r.authority_epoch,
        least(clock_timestamp()+interval '30 seconds',_r.token_expires_at,_r.deletion_deadline,_storage.expires_at,_p.expires_at)) returning * into _s;
    insert into clinical_private.recording_segment_events(segment_id,actor_id,action,authority_epoch)
      values(_s.id,clinical_private.actor_person_id(),'segment.reserved',_r.authority_epoch);
  end if;
  return jsonb_build_object('segmentId',_s.id,'recordingId',_recording,'sessionId',_session,'sequence',_s.sequence,
    'sha256',_s.content_sha256,'bytes',_s.byte_length,'authorityEpoch',_s.authority_epoch,'contentType',_r.content_type,
    'status',_s.status,'objectVersion',_s.object_version,'objectKey',_s.object_key,'acceptBefore',_s.accept_before,
    'storage',_storage.configuration);
end $$;

-- Only the server calls this after checking S3 version/checksum/length/KMS/owner.
-- A client-supplied upload acknowledgment is not sufficient evidence.
create function clinical_private.complete_recording_segment(_recording uuid,_session uuid,_token text,
  _segment uuid,_sha256 text,_bytes integer,_version text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _r clinical_private.encounter_captures; _s clinical_private.recording_segments;
  _storage clinical_private.recording_storage_releases; _org uuid;
begin
  perform clinical_private.authorize_encounter_capture(_recording,_session,_token,'recording');
  select * into _r from clinical_private.encounter_captures where id=_recording;
  select organization_id into _org from clinical_private.recording_controls where encounter_id=_r.encounter_id;
  _storage:=clinical_private.require_recording_storage_release(_r.release_id,_org);
  select * into _s from clinical_private.recording_segments where id=_segment and recording_id=_recording for update;
  if not found then raise exception using errcode='42501',message='recording_access_refused'; end if;
  if _sha256 is distinct from _s.content_sha256 or _bytes is distinct from _s.byte_length
    or _s.authority_epoch<>_r.authority_epoch or _s.recording_grant_ids is distinct from _r.recording_grant_ids
    or _s.storage_release_id<>_storage.id or _version is null or _version='null'
    or length(_version) not between 1 and 1024 or _version !~ '^[A-Za-z0-9+/=._-]+$' then
    raise exception using errcode='40001',message='recording_segment_conflict'; end if;
  if _s.status='stored' then
    if _s.object_version<>_version then raise exception using errcode='40001',message='recording_segment_conflict'; end if;
  else
    if _s.accept_before<=clock_timestamp() then raise exception using errcode='55000',message='recording_reservation_expired'; end if;
    update clinical_private.recording_segments set status='stored',object_version=_version,stored_at=clock_timestamp()
      where id=_segment returning * into _s;
    insert into clinical_private.recording_segment_events(segment_id,actor_id,action,authority_epoch)
      values(_s.id,clinical_private.actor_person_id(),'segment.stored',_r.authority_epoch);
  end if;
  return jsonb_build_object('segmentId',_s.id,'recordingId',_recording,'sequence',_s.sequence,
    'sha256',_s.content_sha256,'bytes',_s.byte_length,'authorityEpoch',_s.authority_epoch,'status','stored');
end $$;
revoke all on function clinical_private.require_recording_storage_release(uuid,uuid),clinical_private.guard_recording_segment_update() from public,clinical_core_api;
revoke all on function clinical_private.reserve_recording_segment(uuid,uuid,text,integer,text,integer),
  clinical_private.complete_recording_segment(uuid,uuid,text,uuid,text,integer,text) from public;
grant execute on function clinical_private.reserve_recording_segment(uuid,uuid,text,integer,text,integer),
  clinical_private.complete_recording_segment(uuid,uuid,text,uuid,text,integer,text) to clinical_core_api;
