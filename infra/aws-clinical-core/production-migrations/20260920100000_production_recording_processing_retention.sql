-- Production overlay: retention enforcement after processing-consent withdrawal.
--
-- Enforced default policy (recorded here; a different policy needs a new
-- migration, not a configuration flag): when any participant withdraws
-- transcription or AI-drafting consent for a recording that has a
-- transcription or drafting job, every processing object derived under that
-- consent (assembled media, provider output, transcript objects, proposed-note
-- objects and declared orphans) is scheduled for hold-aware deletion now, and
-- open jobs are cancelled. Audio segments keep the recording's own retention:
-- they are governed by recording consent and the capture deadline. Database
-- rows (digests, versions, events) stay as the immutable record that
-- processing happened and what was deleted. A provider-side copy cannot be
-- deleted by this service (no delete permission is granted) and backups are
-- not covered; the status function says so instead of issuing a receipt.
alter table clinical_private.recording_cleanup_intents add column scope text not null default 'recording' check(scope in ('recording','processing'));
alter table clinical_private.recording_cleanup_intents drop constraint recording_cleanup_intents_reason_check;
alter table clinical_private.recording_cleanup_intents add constraint recording_cleanup_intents_reason_check
  check(reason in ('retention_deadline','discard','consent_revoked','processing_consent_revoked'));
alter table clinical_private.recording_cleanup_intents add constraint recording_cleanup_intents_scope_reason
  check((scope='processing')=(reason='processing_consent_revoked'));
alter table clinical_private.recording_cleanup_intent_events add column scope text not null default 'recording' check(scope in ('recording','processing'));
alter table clinical_private.recording_cleanup_intent_events drop constraint recording_cleanup_intent_events_reason_check;
alter table clinical_private.recording_cleanup_intent_events add constraint recording_cleanup_intent_events_reason_check
  check(reason in ('retention_deadline','discard','consent_revoked','processing_consent_revoked'));
create index recording_transcription_jobs_grants on clinical_private.recording_transcription_jobs using gin(transcription_grant_ids);
create index recording_drafting_jobs_grants on clinical_private.recording_drafting_jobs using gin(drafting_grant_ids);

-- Scope may narrow to processing only from a future retention deadline, and
-- widens back to the whole recording with a recording-level reason.
create or replace function clinical_private.guard_recording_cleanup_intent() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op='DELETE' or new.version<>old.version+1 or new.due_at>old.due_at
    or new.reason='retention_deadline'
    or (new.scope<>old.scope and new.reason=old.reason)
    or (old.scope='recording' and new.scope='processing' and old.reason<>'retention_deadline')
    or (to_jsonb(new)-array['due_at','reason','version','scope'])
      is distinct from (to_jsonb(old)-array['due_at','reason','version','scope']) then
    raise exception using errcode='55000',message='recording_cleanup_intent_immutable'; end if;
  return new;
end $$;

create or replace function clinical_private.enqueue_recording_cleanup(_recording uuid,_reason text) returns void
language plpgsql security definer set search_path='' as $$
declare _capture clinical_private.encounter_captures; _control clinical_private.recording_controls;
  _intent clinical_private.recording_cleanup_intents; _due timestamptz; _scope text;
begin
  if _reason is null or _reason not in ('retention_deadline','discard','consent_revoked','processing_consent_revoked') then
    raise exception using errcode='22023',message='recording_cleanup_reason_invalid'; end if;
  select * into strict _capture from clinical_private.encounter_captures where id=_recording;
  select * into strict _control from clinical_private.recording_controls where encounter_id=_capture.encounter_id;
  if (_reason='discard' and not exists(select 1 from clinical_private.recording_dispositions where recording_id=_recording and disposition='discard'))
    or (_reason='consent_revoked' and _capture.status<>'revoked' and not exists(
      select 1 from clinical_private.recording_consent_withdrawals where grant_id=any(_capture.recording_grant_ids)))
    -- Processing consent must actually have been withdrawn for a grant one of this recording's jobs relied on.
    or (_reason='processing_consent_revoked' and not exists(
      select 1 from clinical_private.recording_consent_withdrawals w
      where exists(select 1 from clinical_private.recording_transcription_jobs j where j.recording_id=_recording and j.transcription_grant_ids @> array[w.grant_id])
         or exists(select 1 from clinical_private.recording_drafting_jobs d where d.recording_id=_recording and d.drafting_grant_ids @> array[w.grant_id]))) then
    raise exception using errcode='55000',message='recording_cleanup_state_invalid'; end if;
  _scope:=case when _reason='processing_consent_revoked' then 'processing' else 'recording' end;
  _due:=case when _reason='retention_deadline' then _capture.deletion_deadline else least(clock_timestamp(),_capture.deletion_deadline) end;
  insert into clinical_private.recording_cleanup_intents(recording_id,organization_id,patient_record_id,capture_release_id,due_at,reason,scope)
    values(_recording,_control.organization_id,_control.patient_record_id,_capture.release_id,_due,_reason,_scope)
    on conflict(recording_id) do nothing returning * into _intent;
  if not found then
    select * into strict _intent from clinical_private.recording_cleanup_intents where recording_id=_recording for update;
    if _reason='retention_deadline' or _intent.reason=_reason then return; end if;
    -- A whole-recording intent that is already actionable covers every processing object.
    if _reason='processing_consent_revoked' and _intent.scope='recording' and _intent.reason<>'retention_deadline' then return; end if;
    update clinical_private.recording_cleanup_intents set due_at=least(due_at,_due),reason=_reason,scope=_scope,version=version+1
      where recording_id=_recording returning * into _intent;
  end if;
  insert into clinical_private.recording_cleanup_intent_events(recording_id,reason,due_at,version,scope)
    values(_recording,_intent.reason,_intent.due_at,_intent.version,_intent.scope);
end $$;

create or replace function clinical_private.recording_cleanup_withdrawal_trigger() returns trigger
language plpgsql security definer set search_path='' as $$
declare _id uuid;
begin
  for _id in select id from clinical_private.encounter_captures
    where recording_grant_ids @> array[new.grant_id] order by id loop
    perform clinical_private.enqueue_recording_cleanup(_id,'consent_revoked');
  end loop;
  -- Transcription or drafting consent withdrawn: the objects those jobs produced go to cleanup now.
  for _id in select distinct recording_id from (
      select recording_id from clinical_private.recording_transcription_jobs where transcription_grant_ids @> array[new.grant_id]
      union select recording_id from clinical_private.recording_drafting_jobs where drafting_grant_ids @> array[new.grant_id]) x order by recording_id loop
    perform clinical_private.enqueue_recording_cleanup(_id,'processing_consent_revoked');
  end loop;
  return new;
end $$;

create or replace function clinical_private.recording_cleanup_cancels_transcription() returns trigger
language plpgsql security definer set search_path='' as $$
declare _j clinical_private.recording_transcription_jobs; _d clinical_private.recording_drafting_jobs;
begin
  if new.reason not in ('discard','consent_revoked','processing_consent_revoked') and new.due_at>clock_timestamp() then return new; end if;
  for _j in select * from clinical_private.recording_transcription_jobs where recording_id=new.recording_id and status in ('requested','processing') order by id loop
    update clinical_private.recording_transcription_jobs set status='cancelled',updated_at=clock_timestamp() where id=_j.id;
    insert into clinical_private.recording_transcription_events(recording_id,job_id,actor_id,action)
      values(_j.recording_id,_j.id,clinical_private.actor_person_id(),'transcription.cancelled');
  end loop;
  for _d in select * from clinical_private.recording_drafting_jobs where recording_id=new.recording_id and status='requested' order by id loop
    update clinical_private.recording_drafting_jobs set status='cancelled',updated_at=clock_timestamp() where id=_d.id;
    insert into clinical_private.recording_drafting_events(recording_id,job_id,actor_id,action)
      values(_d.recording_id,_d.id,clinical_private.actor_person_id(),'drafting.cancelled');
  end loop;
  return new;
end $$;

-- Admission carries the scope. Audio is actionable for a whole-recording intent,
-- or for a processing intent once the capture's own deadline has arrived.
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
  -- Only an open reservation can still receive an upload; a stored segment is immutable and its window no longer matters.
  if _version is null or _version<>_intent.version or _intent.due_at>clock_timestamp()
    or exists(select 1 from clinical_private.recording_segments where recording_id=_recording and status='reserved' and accept_before>clock_timestamp())
    or exists(select 1 from clinical_private.recording_transcription_jobs where recording_id=_recording and status in ('requested','processing'))
    or exists(select 1 from clinical_private.recording_drafting_jobs where recording_id=_recording and status='requested') then
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
  _actor:=clinical_private.recording_cleanup_operator(_intent.organization_id);
  insert into clinical_private.recording_cleanup_access_events(recording_id,patient_record_id,actor_id,action,release_id,resource_id)
    values(_recording,_intent.patient_record_id,_actor,'cleanup.admitted',_release,_recording);
  return jsonb_build_object('recordingId',_recording,'sessionId',_capture.capture_session_id,'organizationId',_intent.organization_id,'patientRecordId',_intent.patient_record_id,
    'version',_intent.version,'cleanupReleaseId',_release,'workerSha256',_worker_sha256,'storageReleaseId',_storage.id,
    'storage',_storage.configuration,'inventory',_inventory,'inventorySha256',encode(public.digest(_inventory::text,'sha256'),'hex'),
    'transcriptionInventory',_artifacts,'transcriptionInventorySha256',encode(public.digest(_artifacts::text,'sha256'),'hex'),
    'scope',_intent.scope,'audioActionable',(_intent.scope='recording' or _capture.deletion_deadline<=clock_timestamp()),
    'validUntil',least(clock_timestamp()+interval '5 seconds',_release_row.expires_at,
      (select expires_at from clinical_private.recording_cleanup_operators where organization_id=_intent.organization_id and operator_id=_actor)),
    'audioDeleted',false);
end $$;

create or replace function clinical_private.list_recording_cleanup_work(_after uuid default null,_limit integer default 25) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform clinical_private.recording_cleanup_operator(clinical_private.organization_id());
  if _limit is null or _limit not between 1 and 100 then raise exception using errcode='22023',message='recording_cleanup_run_invalid'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('recordingId',q.recording_id,'patientRecordId',q.patient_record_id,
    'version',q.version,'reason',q.reason,'scope',q.scope,'dueAt',q.due_at,'nextCheckAt',q.next_check_at,'leaseUntil',q.lease_until,
    'lastOutcome',q.last_outcome,'consecutiveFailures',q.consecutive_failures,'unresolvedAttempts',q.unresolved_attempts,
    'audioDeleted',false,'requiresRecheck',true) order by q.recording_id) from (
      select i.*,w.next_check_at,w.lease_until,w.last_outcome,w.consecutive_failures,
        (select count(*)::integer from clinical_private.recording_cleanup_attempts a where a.recording_id=i.recording_id
          and not exists(select 1 from clinical_private.recording_cleanup_attempt_events e where e.attempt_id=a.id and e.outcome='delete_acknowledged')) unresolved_attempts
      from clinical_private.recording_cleanup_intents i join clinical_private.recording_cleanup_work w on w.recording_id=i.recording_id
      where i.organization_id=clinical_private.organization_id() and (_after is null or i.recording_id>_after)
      order by i.recording_id limit _limit) q),'[]'::jsonb);
end $$;

-- Operator-readable status of processing-object deletion. Counts, never a
-- receipt: an object is "deleted" only when a durable attempt for its exact
-- version was acknowledged by storage. Declared objects with no result row and
-- no artifact row may still exist in storage until reconciliation registers
-- them. The provider copy and backups are named as not verifiable / not covered.
create function clinical_private.recording_processing_deletion_status(_recording uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _intent clinical_private.recording_cleanup_intents; _capture clinical_private.encounter_captures; _actor uuid;
  _registered integer; _acknowledged integer; _retained integer; _unknown integer; _unattempted integer; _declared integer;
  _open integer; _jobs integer;
begin
  _actor:=clinical_private.recording_cleanup_operator(clinical_private.organization_id());
  select * into _intent from clinical_private.recording_cleanup_intents where recording_id=_recording and organization_id=clinical_private.organization_id();
  if not found then raise exception using errcode='42501',message='recording_cleanup_operator_required'; end if;
  select * into strict _capture from clinical_private.encounter_captures where id=_recording;
  select count(*)::integer into _registered from clinical_private.recording_transcription_artifacts where recording_id=_recording;
  select count(*)::integer into _acknowledged from clinical_private.recording_transcription_artifacts x
    where x.recording_id=_recording and exists(select 1 from clinical_private.recording_cleanup_attempts a join clinical_private.recording_cleanup_attempt_events e on e.attempt_id=a.id
      where a.artifact_id=x.id and a.object_version=x.object_version and e.outcome='delete_acknowledged');
  select count(*)::integer into _retained from clinical_private.recording_transcription_artifacts x
    where x.recording_id=_recording
      and not exists(select 1 from clinical_private.recording_cleanup_attempts a join clinical_private.recording_cleanup_attempt_events e on e.attempt_id=a.id where a.artifact_id=x.id and e.outcome='delete_acknowledged')
      and exists(select 1 from clinical_private.recording_cleanup_attempts a join clinical_private.recording_cleanup_attempt_events e on e.attempt_id=a.id where a.artifact_id=x.id and e.outcome in ('retained','refused'));
  select count(*)::integer into _unknown from clinical_private.recording_transcription_artifacts x
    where x.recording_id=_recording
      and exists(select 1 from clinical_private.recording_cleanup_attempts a where a.artifact_id=x.id)
      and not exists(select 1 from clinical_private.recording_cleanup_attempts a join clinical_private.recording_cleanup_attempt_events e on e.attempt_id=a.id where a.artifact_id=x.id and e.outcome in ('delete_acknowledged','retained','refused'));
  _unattempted:=_registered-_acknowledged-_retained-_unknown;
  select count(*)::integer into _declared from clinical_private.recording_object_intents i where i.recording_id=_recording
    and not exists(select 1 from clinical_private.recording_transcription_artifacts a where a.object_key=i.object_key);
  select count(*)::integer into _open from (
    select id from clinical_private.recording_transcription_jobs where recording_id=_recording and status in ('requested','processing')
    union all select id from clinical_private.recording_drafting_jobs where recording_id=_recording and status='requested') j;
  select count(*)::integer into _jobs from (
    select id from clinical_private.recording_transcription_jobs where recording_id=_recording
    union all select id from clinical_private.recording_drafting_jobs where recording_id=_recording) j;
  insert into clinical_private.recording_cleanup_review_events(organization_id,actor_id,action,recording_id,returned_rows)
    values(clinical_private.organization_id(),_actor,'history.read',_recording,0);
  return jsonb_build_object('recordingId',_recording,'scope',_intent.scope,'reason',_intent.reason,'dueAt',_intent.due_at,'version',_intent.version,
    'audioActionable',(_intent.scope='recording' or _capture.deletion_deadline<=clock_timestamp()),'audioDeadline',_capture.deletion_deadline,
    'processed',_jobs>0,'openJobs',_open,
    'artifacts',jsonb_build_object('registered',_registered,'deleteAcknowledged',_acknowledged,'retained',_retained,'unknown',_unknown,'unattempted',_unattempted),
    'declaredWithoutArtifact',_declared,
    'processingObjectsDeleted',(_open=0 and _declared=0 and _registered=_acknowledged),
    'providerCopy','not_verifiable_no_delete_permission','backups','not_covered','audioDeleted',false);
end $$;

revoke all on function clinical_private.guard_recording_cleanup_intent(),clinical_private.enqueue_recording_cleanup(uuid,text),
  clinical_private.recording_cleanup_withdrawal_trigger(),clinical_private.recording_cleanup_cancels_transcription(),
  clinical_private.list_recording_cleanup_work(uuid,integer) from public,clinical_core_api;
grant execute on function clinical_private.list_recording_cleanup_work(uuid,integer) to clinical_core_api;
revoke all on function clinical_private.recording_processing_deletion_status(uuid) from public;
grant execute on function clinical_private.recording_processing_deletion_status(uuid) to clinical_core_api;
