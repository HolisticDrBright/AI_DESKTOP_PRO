-- Persist an exact version-scoped intent BEFORE a remote delete. Unknown
-- outcomes survive rollback/timeouts of the later authorization transaction.
-- No table/function here claims complete erasure or removes a cleanup intent.
create table clinical_private.recording_cleanup_attempts (
  id uuid primary key,
  recording_id uuid not null references clinical_private.recording_cleanup_intents(recording_id),
  segment_id uuid not null references clinical_private.recording_segments(id),
  cleanup_release_id uuid not null references clinical_private.recording_cleanup_releases(id),
  queue_version bigint not null check(queue_version>0),
  inventory_sha256 text not null check(inventory_sha256 ~ '^[a-f0-9]{64}$'),
  object_version text not null check(length(object_version) between 1 and 1024 and object_version<>'null' and object_version ~ '^[A-Za-z0-9+/=._-]+$'),
  object_kind text not null check(object_kind in ('object','delete_marker')),
  evidence_sha256 text not null check(evidence_sha256 ~ '^[a-f0-9]{64}$'),
  requested_by uuid not null references clinical_core.persons(id),
  requested_at timestamptz not null default clock_timestamp()
);
create index recording_cleanup_attempts_recording on clinical_private.recording_cleanup_attempts(recording_id,requested_at,id);
create table clinical_private.recording_cleanup_attempt_events (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references clinical_private.recording_cleanup_attempts(id),
  outcome text not null check(outcome in ('delete_acknowledged','unknown','retained','refused')),
  evidence_sha256 text not null check(evidence_sha256 ~ '^[a-f0-9]{64}$'),
  actor_id uuid not null references clinical_core.persons(id),
  recorded_at timestamptz not null default clock_timestamp(),
  unique(attempt_id,outcome,evidence_sha256)
);
alter table clinical_private.recording_cleanup_attempts enable row level security;
alter table clinical_private.recording_cleanup_attempts force row level security;
alter table clinical_private.recording_cleanup_attempt_events enable row level security;
alter table clinical_private.recording_cleanup_attempt_events force row level security;
revoke all on clinical_private.recording_cleanup_attempts,clinical_private.recording_cleanup_attempt_events from public,clinical_core_api;
create trigger recording_cleanup_attempt_immutable before update or delete on clinical_private.recording_cleanup_attempts
  for each row execute function clinical_private.block_update_delete();
create trigger recording_cleanup_attempt_event_immutable before update or delete on clinical_private.recording_cleanup_attempt_events
  for each row execute function clinical_private.block_update_delete();

create function clinical_private.prepare_recording_cleanup_attempt(_recording uuid,_version bigint,_release uuid,_worker text,
  _attempt uuid,_segment uuid,_object_version text,_kind text,_inventory text,_evidence text) returns uuid
language plpgsql security definer set search_path='' as $$
declare _admission jsonb; _row clinical_private.recording_cleanup_attempts; _actor uuid:=clinical_private.actor_person_id();
begin
  _admission:=clinical_private.admit_recording_cleanup(_recording,_version,_release,_worker);
  if _attempt is null or _segment is null or _object_version is null or length(_object_version) not between 1 and 1024
    or _object_version='null' or _object_version!~'^[A-Za-z0-9+/=._-]+$' or _kind is null or _kind not in ('object','delete_marker')
    or _inventory is distinct from (_admission->>'inventorySha256') or _evidence is null or _evidence!~'^[a-f0-9]{64}$'
    or not exists(select 1 from clinical_private.recording_segments where id=_segment and recording_id=_recording) then
    raise exception using errcode='22023',message='recording_cleanup_attempt_invalid'; end if;
  insert into clinical_private.recording_cleanup_attempts(id,recording_id,segment_id,cleanup_release_id,queue_version,
    inventory_sha256,object_version,object_kind,evidence_sha256,requested_by)
    values(_attempt,_recording,_segment,_release,_version,_inventory,_object_version,_kind,_evidence,_actor)
    on conflict(id) do nothing;
  select * into strict _row from clinical_private.recording_cleanup_attempts where id=_attempt;
  if _row.recording_id<>_recording or _row.segment_id<>_segment or _row.cleanup_release_id<>_release
    or _row.queue_version<>_version or _row.inventory_sha256<>_inventory or _row.object_version<>_object_version
    or _row.object_kind<>_kind or _row.evidence_sha256<>_evidence or _row.requested_by<>_actor then
    raise exception using errcode='55000',message='recording_cleanup_attempt_conflict'; end if;
  return _attempt;
end $$;

create function clinical_private.admit_recording_cleanup_attempt(_recording uuid,_version bigint,_release uuid,_worker text,_attempt uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _admission jsonb; _row clinical_private.recording_cleanup_attempts;
begin
  _admission:=clinical_private.admit_recording_cleanup(_recording,_version,_release,_worker);
  select * into _row from clinical_private.recording_cleanup_attempts where id=_attempt;
  if not found or _row.recording_id<>_recording or _row.queue_version<>_version or _row.cleanup_release_id<>_release
    or _row.inventory_sha256<>(_admission->>'inventorySha256') or _row.requested_by<>clinical_private.actor_person_id() then
    raise exception using errcode='42501',message='recording_cleanup_attempt_required'; end if;
  return _admission||jsonb_build_object('attempt',jsonb_build_object('id',_row.id,'segmentId',_row.segment_id,
    'objectVersion',_row.object_version,'kind',_row.object_kind,'evidenceSha256',_row.evidence_sha256));
end $$;

create function clinical_private.record_recording_cleanup_attempt(_attempt uuid,_outcome text,_evidence text) returns uuid
language plpgsql security definer set search_path='' as $$
declare _row clinical_private.recording_cleanup_attempts; _org uuid; _actor uuid;
begin
  select a.* into _row from clinical_private.recording_cleanup_attempts a
    join clinical_private.recording_cleanup_intents i on i.recording_id=a.recording_id
    where a.id=_attempt and i.organization_id=clinical_private.organization_id();
  if not found then raise exception using errcode='42501',message='recording_cleanup_attempt_required'; end if;
  select organization_id into _org from clinical_private.recording_cleanup_intents where recording_id=_row.recording_id;
  _actor:=clinical_private.recording_cleanup_operator(_org);
  if _row.requested_by<>_actor then raise exception using errcode='42501',message='recording_cleanup_attempt_required'; end if;
  if _outcome is null or _outcome not in ('delete_acknowledged','unknown','retained','refused')
    or _evidence is null or _evidence!~'^[a-f0-9]{64}$' then
    raise exception using errcode='22023',message='recording_cleanup_attempt_invalid'; end if;
  -- Recording an outcome after a newly placed hold is allowed; this authorizes
  -- no further mutation. Missing events remain visibly uncertain, never success.
  insert into clinical_private.recording_cleanup_attempt_events(attempt_id,outcome,evidence_sha256,actor_id)
    values(_attempt,_outcome,_evidence,_actor) on conflict(attempt_id,outcome,evidence_sha256) do nothing;
  return _attempt;
end $$;
revoke all on function clinical_private.prepare_recording_cleanup_attempt(uuid,bigint,uuid,text,uuid,uuid,text,text,text,text),
  clinical_private.admit_recording_cleanup_attempt(uuid,bigint,uuid,text,uuid),
  clinical_private.record_recording_cleanup_attempt(uuid,text,text) from public,clinical_core_api;
grant execute on function clinical_private.prepare_recording_cleanup_attempt(uuid,bigint,uuid,text,uuid,uuid,text,text,text,text),
  clinical_private.admit_recording_cleanup_attempt(uuid,bigint,uuid,text,uuid),
  clinical_private.record_recording_cleanup_attempt(uuid,text,text) to clinical_core_api;
