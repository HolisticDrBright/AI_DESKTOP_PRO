-- Cleanup admission is separate from capture permission. No approvals, operators,
-- holds, storage deletions or erasure receipts are seeded by this migration.
create table clinical_private.recording_cleanup_operators (
  organization_id uuid not null references clinical_core.organizations(id),
  operator_id uuid not null references clinical_core.persons(id),
  reviewed_by uuid not null references clinical_core.persons(id),
  evidence_sha256 text not null check(evidence_sha256 ~ '^[a-f0-9]{64}$'),
  approved_at timestamptz not null,
  expires_at timestamptz not null check(expires_at>approved_at),
  revoked_at timestamptz,
  primary key(organization_id,operator_id),
  check(operator_id<>reviewed_by)
);
create table clinical_private.recording_cleanup_releases (
  id uuid primary key default gen_random_uuid(),
  capture_release_id uuid not null references clinical_private.recording_capture_releases(id),
  storage_release_id uuid not null references clinical_private.recording_storage_releases(id),
  retention_policy_version text not null references clinical_private.owned_retention_policies(version),
  retention_policy_sha256 text not null check(retention_policy_sha256 ~ '^[a-f0-9]{64}$'),
  worker_sha256 text not null check(worker_sha256 ~ '^[a-f0-9]{64}$'),
  qualification_sha256 text not null check(qualification_sha256 ~ '^[a-f0-9]{64}$'),
  approved_by text not null check(btrim(approved_by)<>''),
  approved_at timestamptz not null,
  expires_at timestamptz not null check(expires_at>approved_at),
  retired_at timestamptz
);
create table clinical_private.recording_legal_holds (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  patient_record_id uuid not null,
  reason_code text not null check(reason_code in ('litigation','regulatory_inquiry','security_investigation','owner_dispute')),
  placed_by uuid not null references clinical_core.persons(id),
  placed_at timestamptz not null default clock_timestamp(),
  released_by uuid references clinical_core.persons(id),
  released_at timestamptz,
  foreign key(patient_record_id,organization_id) references clinical_core.patient_records(id,organization_id),
  check((released_at is null)=(released_by is null))
);
create index recording_legal_holds_active on clinical_private.recording_legal_holds(patient_record_id) where released_at is null;
-- Preserve historical subject attribution even if a connection is later removed.
-- Association does not confer access or consent to any consumer.
create table clinical_private.recording_cleanup_subjects (
  recording_id uuid not null references clinical_private.encounter_captures(id),
  owner_id uuid not null references clinical_core.persons(id),
  primary key(recording_id,owner_id)
);
create table clinical_private.recording_cleanup_access_events (
  id uuid primary key default gen_random_uuid(),
  recording_id uuid references clinical_private.encounter_captures(id),
  patient_record_id uuid not null references clinical_core.patient_records(id),
  actor_id uuid not null references clinical_core.persons(id),
  action text not null check(action in ('cleanup.admitted','hold.placed','hold.released')),
  release_id uuid references clinical_private.recording_cleanup_releases(id),
  resource_id uuid not null,
  created_at timestamptz not null default clock_timestamp()
);
alter table clinical_private.recording_cleanup_operators enable row level security;
alter table clinical_private.recording_cleanup_operators force row level security;
alter table clinical_private.recording_cleanup_releases enable row level security;
alter table clinical_private.recording_cleanup_releases force row level security;
alter table clinical_private.recording_legal_holds enable row level security;
alter table clinical_private.recording_legal_holds force row level security;
alter table clinical_private.recording_cleanup_subjects enable row level security;
alter table clinical_private.recording_cleanup_subjects force row level security;
alter table clinical_private.recording_cleanup_access_events enable row level security;
alter table clinical_private.recording_cleanup_access_events force row level security;
revoke all on clinical_private.recording_cleanup_operators,clinical_private.recording_cleanup_releases,
  clinical_private.recording_legal_holds,clinical_private.recording_cleanup_subjects,
  clinical_private.recording_cleanup_access_events from public,clinical_core_api;
create trigger recording_cleanup_subjects_immutable before update or delete on clinical_private.recording_cleanup_subjects
  for each row execute function clinical_private.block_update_delete();
create trigger recording_cleanup_access_immutable before update or delete on clinical_private.recording_cleanup_access_events
  for each row execute function clinical_private.block_update_delete();
create function clinical_private.guard_recording_cleanup_review() returns trigger
language plpgsql security definer set search_path='' as $$
declare _mutable text[];
begin
  if tg_op='DELETE' then raise exception using errcode='55000',message='recording_cleanup_review_immutable'; end if;
  _mutable:=case tg_table_name when 'recording_cleanup_operators' then array['revoked_at']
    when 'recording_cleanup_releases' then array['retired_at'] else array['released_at','released_by'] end;
  if (to_jsonb(old)-_mutable) is distinct from (to_jsonb(new)-_mutable)
    or (to_jsonb(old)->>(_mutable[1])) is not null or (to_jsonb(new)->>(_mutable[1])) is null then
    raise exception using errcode='55000',message='recording_cleanup_review_immutable'; end if;
  return new;
end $$;
create trigger recording_cleanup_operator_guard before update or delete on clinical_private.recording_cleanup_operators
  for each row execute function clinical_private.guard_recording_cleanup_review();
create trigger recording_cleanup_release_guard before update or delete on clinical_private.recording_cleanup_releases
  for each row execute function clinical_private.guard_recording_cleanup_review();
create trigger recording_legal_hold_guard before update or delete on clinical_private.recording_legal_holds
  for each row execute function clinical_private.guard_recording_cleanup_review();

create function clinical_private.lock_recording_cleanup_patient(_patient uuid) returns void
language sql security definer set search_path='' as $$
  select pg_advisory_xact_lock(hashtextextended('recording-cleanup-patient:'||_patient::text,0));
$$;
create function clinical_private.recording_cleanup_subject_trigger() returns trigger
language plpgsql security definer set search_path='' as $$
declare _patient uuid;
begin
  if tg_table_name='recording_cleanup_intents' then
    perform clinical_private.lock_recording_cleanup_patient(new.patient_record_id);
    insert into clinical_private.recording_cleanup_subjects(recording_id,owner_id)
      select new.recording_id,c.consumer_person_id from clinical_core.patient_connections c
      where c.patient_record_id=new.patient_record_id and c.consumer_person_id is not null on conflict do nothing;
  else
    -- Same serialization as cleanup admission, including association changes.
    for _patient in select distinct id from unnest(array[
      case when tg_op<>'INSERT' then old.patient_record_id end,
      case when tg_op<>'DELETE' then new.patient_record_id end]) id where id is not null order by id loop
      perform clinical_private.lock_recording_cleanup_patient(_patient);
    end loop;
    if tg_op<>'DELETE' and new.consumer_person_id is not null then
      insert into clinical_private.recording_cleanup_subjects(recording_id,owner_id)
        select i.recording_id,new.consumer_person_id from clinical_private.recording_cleanup_intents i
        where i.patient_record_id=new.patient_record_id on conflict do nothing;
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
create trigger recording_cleanup_subject_on_intent after insert on clinical_private.recording_cleanup_intents
  for each row execute function clinical_private.recording_cleanup_subject_trigger();
create trigger recording_cleanup_subject_on_connection before insert or update or delete on clinical_core.patient_connections
  for each row execute function clinical_private.recording_cleanup_subject_trigger();
insert into clinical_private.recording_cleanup_subjects(recording_id,owner_id)
  select i.recording_id,c.consumer_person_id from clinical_private.recording_cleanup_intents i
  join clinical_core.patient_connections c on c.patient_record_id=i.patient_record_id
  where c.consumer_person_id is not null on conflict do nothing;

create function clinical_private.recording_cleanup_operator(_organization uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.privacy_operator(); _assignment clinical_private.recording_cleanup_operators;
begin
  if clinical_private.organization_id() is distinct from _organization
    or clinical_private.claim('data_classification') is distinct from 'clinical_phi' then
    raise exception using errcode='42501',message='recording_cleanup_operator_required'; end if;
  perform 1 from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
    join clinical_core.organization_memberships m on m.person_id=p.id and m.organization_id=_organization
    join clinical_core.organizations o on o.id=m.organization_id
    where i.person_id=_actor and i.identity_pool='workforce' and i.identity_subject=clinical_private.claim('identity_subject')
    and i.status='active' and i.production_bound=true and p.status='active' and m.status='active' and o.status='active'
    for share of i,p,m,o;
  if not found then raise exception using errcode='42501',message='recording_cleanup_operator_required'; end if;
  select * into _assignment from clinical_private.recording_cleanup_operators
    where organization_id=_organization and operator_id=_actor for share;
  if not found or _assignment.revoked_at is not null or _assignment.approved_at>clock_timestamp()
    or _assignment.expires_at<=clock_timestamp() then
    raise exception using errcode='42501',message='recording_cleanup_operator_required'; end if;
  return _actor;
end $$;

create function clinical_private.place_recording_legal_hold(_patient uuid,_reason text) returns uuid
language plpgsql security definer set search_path='' as $$
declare _org uuid; _actor uuid; _id uuid;
begin
  select organization_id into _org from clinical_core.patient_records where id=_patient;
  _actor:=clinical_private.recording_cleanup_operator(_org);
  perform clinical_private.lock_recording_cleanup_patient(_patient);
  if _reason is null or _reason not in ('litigation','regulatory_inquiry','security_investigation','owner_dispute') then
    raise exception using errcode='22023',message='recording_hold_reason_invalid'; end if;
  insert into clinical_private.recording_legal_holds(organization_id,patient_record_id,reason_code,placed_by)
    values(_org,_patient,_reason,_actor) returning id into _id;
  insert into clinical_private.recording_cleanup_access_events(patient_record_id,actor_id,action,resource_id)
    values(_patient,_actor,'hold.placed',_id);
  return _id;
end $$;
create function clinical_private.release_recording_legal_hold(_hold uuid) returns void
language plpgsql security definer set search_path='' as $$
declare _h clinical_private.recording_legal_holds; _actor uuid;
begin
  select * into _h from clinical_private.recording_legal_holds where id=_hold;
  _actor:=clinical_private.recording_cleanup_operator(_h.organization_id);
  perform clinical_private.lock_recording_cleanup_patient(_h.patient_record_id);
  select * into strict _h from clinical_private.recording_legal_holds where id=_hold for update;
  if _h.released_at is not null then return; end if;
  update clinical_private.recording_legal_holds set released_by=_actor,released_at=clock_timestamp() where id=_hold;
  insert into clinical_private.recording_cleanup_access_events(patient_record_id,actor_id,action,resource_id)
    values(_h.patient_record_id,_actor,'hold.released',_hold);
end $$;

-- Internal guarded admission. Caller MUST retain this transaction while using
-- the inventory; it is not a portable permit or a completed deletion receipt.
-- A separately reviewed worker must reconcile all versions/late writes and must
-- not infer absence from missing PUT receipts. No storage calls in this function.
create function clinical_private.admit_recording_cleanup(_recording uuid,_version bigint,_release uuid,_worker_sha256 text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _intent clinical_private.recording_cleanup_intents; _capture clinical_private.encounter_captures;
  _release_row clinical_private.recording_cleanup_releases; _storage clinical_private.recording_storage_releases;
  _policy clinical_private.owned_retention_policies; _actor uuid; _owner uuid; _inventory jsonb; _encounter uuid;
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
    or exists(select 1 from clinical_private.recording_segments where recording_id=_recording and accept_before>clock_timestamp()) then
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
  -- Authorization may have expired while waiting for the encounter/hold locks.
  _actor:=clinical_private.recording_cleanup_operator(_intent.organization_id);
  insert into clinical_private.recording_cleanup_access_events(recording_id,patient_record_id,actor_id,action,release_id,resource_id)
    values(_recording,_intent.patient_record_id,_actor,'cleanup.admitted',_release,_recording);
  return jsonb_build_object('recordingId',_recording,'sessionId',_capture.capture_session_id,'organizationId',_intent.organization_id,'patientRecordId',_intent.patient_record_id,
    'version',_intent.version,'cleanupReleaseId',_release,'workerSha256',_worker_sha256,'storageReleaseId',_storage.id,
    'storage',_storage.configuration,'inventory',_inventory,'inventorySha256',encode(public.digest(_inventory::text,'sha256'),'hex'),
    'validUntil',least(clock_timestamp()+interval '5 seconds',_release_row.expires_at,
      (select expires_at from clinical_private.recording_cleanup_operators where organization_id=_intent.organization_id and operator_id=_actor)),
    'audioDeleted',false);
end $$;
revoke all on function clinical_private.guard_recording_cleanup_review(),clinical_private.lock_recording_cleanup_patient(uuid),
  clinical_private.recording_cleanup_subject_trigger(),clinical_private.recording_cleanup_operator(uuid),
  clinical_private.place_recording_legal_hold(uuid,text),clinical_private.release_recording_legal_hold(uuid),
  clinical_private.admit_recording_cleanup(uuid,bigint,uuid,text) from public,clinical_core_api;
grant execute on function clinical_private.place_recording_legal_hold(uuid,text),clinical_private.release_recording_legal_hold(uuid),
  clinical_private.admit_recording_cleanup(uuid,bigint,uuid,text) to clinical_core_api;
