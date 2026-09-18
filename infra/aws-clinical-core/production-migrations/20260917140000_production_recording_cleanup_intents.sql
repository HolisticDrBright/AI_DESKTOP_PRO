-- Durable cleanup handoff, not deletion authority or an erasure receipt.
-- Every capture has a deadline, including captures that never reach finish.
-- Storage workers must separately qualify retention/holds and re-read all
-- reserved AND stored objects; a missing receipt does not prove absence.
create table clinical_private.recording_cleanup_intents (
  recording_id uuid primary key references clinical_private.encounter_captures(id),
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null,
  capture_release_id uuid not null references clinical_private.recording_capture_releases(id),
  requested_at timestamptz not null default clock_timestamp(),
  due_at timestamptz not null,
  reason text not null check(reason in ('retention_deadline','discard','consent_revoked')),
  version bigint not null default 1 check(version>0),
  foreign key(patient_record_id,organization_id) references clinical_core.patient_records(id,organization_id)
);
create index recording_cleanup_intents_due on clinical_private.recording_cleanup_intents(due_at,recording_id);
create index encounter_capture_recording_grants on clinical_private.encounter_captures using gin(recording_grant_ids);
create table clinical_private.recording_cleanup_intent_events (
  id uuid primary key default gen_random_uuid(),
  recording_id uuid not null references clinical_private.recording_cleanup_intents(recording_id),
  reason text not null check(reason in ('retention_deadline','discard','consent_revoked')),
  due_at timestamptz not null,
  version bigint not null check(version>0),
  recorded_at timestamptz not null default clock_timestamp(),
  unique(recording_id,version)
);
alter table clinical_private.recording_cleanup_intents enable row level security;
alter table clinical_private.recording_cleanup_intents force row level security;
alter table clinical_private.recording_cleanup_intent_events enable row level security;
alter table clinical_private.recording_cleanup_intent_events force row level security;
revoke all on clinical_private.recording_cleanup_intents,clinical_private.recording_cleanup_intent_events from public,clinical_core_api;
create trigger recording_cleanup_events_immutable before update or delete on clinical_private.recording_cleanup_intent_events
  for each row execute function clinical_private.block_update_delete();

create function clinical_private.guard_recording_cleanup_intent() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op='DELETE' or new.version<>old.version+1 or new.due_at>old.due_at
    or new.reason='retention_deadline'
    or (to_jsonb(new)-array['due_at','reason','version'])
      is distinct from (to_jsonb(old)-array['due_at','reason','version']) then
    raise exception using errcode='55000',message='recording_cleanup_intent_immutable'; end if;
  return new;
end $$;
create trigger recording_cleanup_intent_guard before update or delete on clinical_private.recording_cleanup_intents
  for each row execute function clinical_private.guard_recording_cleanup_intent();

-- Private trigger helper. The caller already holds the encounter/capture lock;
-- no public function can choose another patient, deadline, key or deletion proof.
create function clinical_private.enqueue_recording_cleanup(_recording uuid,_reason text) returns void
language plpgsql security definer set search_path='' as $$
declare _capture clinical_private.encounter_captures; _control clinical_private.recording_controls;
  _intent clinical_private.recording_cleanup_intents; _due timestamptz;
begin
  if _reason is null or _reason not in ('retention_deadline','discard','consent_revoked') then
    raise exception using errcode='22023',message='recording_cleanup_reason_invalid'; end if;
  select * into strict _capture from clinical_private.encounter_captures where id=_recording;
  select * into strict _control from clinical_private.recording_controls where encounter_id=_capture.encounter_id;
  if (_reason='discard' and not exists(select 1 from clinical_private.recording_dispositions where recording_id=_recording and disposition='discard'))
    or (_reason='consent_revoked' and _capture.status<>'revoked' and not exists(
      select 1 from clinical_private.recording_consent_withdrawals where grant_id=any(_capture.recording_grant_ids))) then
    raise exception using errcode='55000',message='recording_cleanup_state_invalid'; end if;
  _due:=case when _reason='retention_deadline' then _capture.deletion_deadline else least(clock_timestamp(),_capture.deletion_deadline) end;
  insert into clinical_private.recording_cleanup_intents(recording_id,organization_id,patient_record_id,capture_release_id,due_at,reason)
    values(_recording,_control.organization_id,_control.patient_record_id,_capture.release_id,_due,_reason)
    on conflict(recording_id) do nothing returning * into _intent;
  if not found then
    select * into strict _intent from clinical_private.recording_cleanup_intents where recording_id=_recording for update;
    if _reason='retention_deadline' or _intent.reason=_reason then return; end if;
    update clinical_private.recording_cleanup_intents set due_at=least(due_at,_due),reason=_reason,version=version+1
      where recording_id=_recording returning * into _intent;
  end if;
  insert into clinical_private.recording_cleanup_intent_events(recording_id,reason,due_at,version)
    values(_recording,_intent.reason,_intent.due_at,_intent.version);
end $$;

create function clinical_private.recording_cleanup_capture_trigger() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op='INSERT' then perform clinical_private.enqueue_recording_cleanup(new.id,'retention_deadline');
  elsif new.status='revoked' and old.status is distinct from new.status then
    perform clinical_private.enqueue_recording_cleanup(new.id,'consent_revoked'); end if;
  return new;
end $$;
create function clinical_private.recording_cleanup_disposition_trigger() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.disposition='discard' then perform clinical_private.enqueue_recording_cleanup(new.recording_id,'discard'); end if;
  return new;
end $$;
create function clinical_private.recording_cleanup_withdrawal_trigger() returns trigger
language plpgsql security definer set search_path='' as $$
declare _id uuid;
begin
  -- Finished captures also retain audio. Revoking their recording grant must
  -- reach the cleanup handoff without reopening or rewriting their disposition.
  for _id in select id from clinical_private.encounter_captures
    where recording_grant_ids @> array[new.grant_id] order by id loop
    perform clinical_private.enqueue_recording_cleanup(_id,'consent_revoked');
  end loop;
  return new;
end $$;
create trigger recording_cleanup_on_capture after insert or update of status on clinical_private.encounter_captures
  for each row execute function clinical_private.recording_cleanup_capture_trigger();
create trigger recording_cleanup_on_disposition after insert on clinical_private.recording_dispositions
  for each row execute function clinical_private.recording_cleanup_disposition_trigger();
create trigger recording_cleanup_on_withdrawal after insert on clinical_private.recording_consent_withdrawals
  for each row execute function clinical_private.recording_cleanup_withdrawal_trigger();

-- Existing captures receive the same handoff, with their original deadline.
-- This does not seed an approval, synthesize storage evidence or delete data.
do $$ declare _capture record; begin
  for _capture in select c.id,c.status,d.disposition,
    exists(select 1 from clinical_private.recording_consent_withdrawals w where w.grant_id=any(c.recording_grant_ids)) withdrawn
    from clinical_private.encounter_captures c
    left join clinical_private.recording_dispositions d on d.recording_id=c.id order by c.id loop
    perform clinical_private.enqueue_recording_cleanup(_capture.id,'retention_deadline');
    if _capture.disposition='discard' then perform clinical_private.enqueue_recording_cleanup(_capture.id,'discard');
    elsif _capture.status='revoked' or _capture.withdrawn then perform clinical_private.enqueue_recording_cleanup(_capture.id,'consent_revoked'); end if;
  end loop;
end $$;
revoke all on function clinical_private.guard_recording_cleanup_intent(),
  clinical_private.enqueue_recording_cleanup(uuid,text),clinical_private.recording_cleanup_capture_trigger(),
  clinical_private.recording_cleanup_disposition_trigger(),clinical_private.recording_cleanup_withdrawal_trigger() from public,clinical_core_api;
