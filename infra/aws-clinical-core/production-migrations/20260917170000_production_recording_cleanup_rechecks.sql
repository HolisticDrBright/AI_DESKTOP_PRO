-- Durable work scheduling. Cadences below are retry intervals, NOT retention
-- policy or evidence of erasure. There is intentionally no completed state.
create table clinical_private.recording_cleanup_runs (
  id uuid primary key,
  recording_id uuid not null references clinical_private.recording_cleanup_intents(recording_id),
  queue_version bigint not null,
  cleanup_release_id uuid not null references clinical_private.recording_cleanup_releases(id),
  worker_sha256 text not null check(worker_sha256 ~ '^[a-f0-9]{64}$'),
  operator_id uuid not null references clinical_core.persons(id),
  claimed_at timestamptz not null default clock_timestamp(),
  lease_until timestamptz not null,
  check(lease_until>claimed_at)
);
create table clinical_private.recording_cleanup_work (
  recording_id uuid primary key references clinical_private.recording_cleanup_intents(recording_id),
  queue_version bigint not null,
  run_id uuid references clinical_private.recording_cleanup_runs(id),
  lease_until timestamptz,
  next_check_at timestamptz not null,
  consecutive_failures integer not null default 0 check(consecutive_failures between 0 and 16),
  last_outcome text check(last_outcome in ('empty_observed','needs_recheck','held','unavailable','refused')),
  check((run_id is null)=(lease_until is null))
);
create index recording_cleanup_work_due on clinical_private.recording_cleanup_work(next_check_at,recording_id);
create index recording_cleanup_intents_org_page on clinical_private.recording_cleanup_intents(organization_id,recording_id);
create table clinical_private.recording_cleanup_run_results (
  run_id uuid primary key references clinical_private.recording_cleanup_runs(id),
  outcome text not null check(outcome in ('empty_observed','needs_recheck','held','unavailable','refused')),
  delete_acknowledged integer check(delete_acknowledged between 0 and 25),
  evidence_sha256 text not null check(evidence_sha256 ~ '^[a-f0-9]{64}$'),
  recorded_at timestamptz not null default clock_timestamp(),
  applied_to_schedule boolean not null,
  next_check_at timestamptz
);
alter table clinical_private.recording_cleanup_runs enable row level security;
alter table clinical_private.recording_cleanup_runs force row level security;
alter table clinical_private.recording_cleanup_work enable row level security;
alter table clinical_private.recording_cleanup_work force row level security;
alter table clinical_private.recording_cleanup_run_results enable row level security;
alter table clinical_private.recording_cleanup_run_results force row level security;
revoke all on clinical_private.recording_cleanup_runs,clinical_private.recording_cleanup_work,clinical_private.recording_cleanup_run_results from public,clinical_core_api;
create trigger recording_cleanup_runs_immutable before update or delete on clinical_private.recording_cleanup_runs
  for each row execute function clinical_private.block_update_delete();
create trigger recording_cleanup_results_immutable before update or delete on clinical_private.recording_cleanup_run_results
  for each row execute function clinical_private.block_update_delete();

create function clinical_private.recording_cleanup_work_trigger() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  insert into clinical_private.recording_cleanup_work(recording_id,queue_version,next_check_at)
    values(new.recording_id,new.version,new.due_at)
    on conflict(recording_id) do update set queue_version=new.version,run_id=null,lease_until=null,
      next_check_at=least(clinical_private.recording_cleanup_work.next_check_at,new.due_at),consecutive_failures=0,last_outcome=null;
  return new;
end $$;
create trigger recording_cleanup_schedule_on_intent after insert or update on clinical_private.recording_cleanup_intents
  for each row execute function clinical_private.recording_cleanup_work_trigger();
insert into clinical_private.recording_cleanup_work(recording_id,queue_version,next_check_at)
  select recording_id,version,due_at from clinical_private.recording_cleanup_intents;

create function clinical_private.claim_recording_cleanup_run(_recording uuid,_version bigint,_release uuid,_worker text,_run uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.recording_cleanup_operator(clinical_private.organization_id());
  _intent clinical_private.recording_cleanup_intents; _work clinical_private.recording_cleanup_work;
  _existing clinical_private.recording_cleanup_runs; _review clinical_private.recording_cleanup_releases;
  _until timestamptz;
begin
  if _run is null then raise exception using errcode='22023',message='recording_cleanup_run_invalid'; end if;
  select * into _intent from clinical_private.recording_cleanup_intents where recording_id=_recording
    and organization_id=clinical_private.organization_id() for share;
  if not found then raise exception using errcode='42501',message='recording_cleanup_operator_required'; end if;
  select * into strict _work from clinical_private.recording_cleanup_work where recording_id=_recording for update;
  select * into _existing from clinical_private.recording_cleanup_runs where id=_run;
  if found then
    if _existing.recording_id<>_recording or _existing.queue_version is distinct from _version
      or _existing.cleanup_release_id is distinct from _release or _existing.worker_sha256 is distinct from _worker
      or _existing.operator_id<>_actor then raise exception using errcode='55000',message='recording_cleanup_run_conflict'; end if;
    -- Replayed claim is an acknowledgment only; NEVER start a second executor.
    return jsonb_build_object('runId',_run,'recordingId',_recording,'version',_version,'claimed',false,'leaseUntil',_existing.lease_until);
  end if;
  if _version is distinct from _intent.version or _intent.due_at>clock_timestamp()
    or _work.next_check_at>clock_timestamp() or (_work.lease_until is not null and _work.lease_until>clock_timestamp()) then
    raise exception using errcode='55000',message='recording_cleanup_not_ready'; end if;
  select * into _review from clinical_private.recording_cleanup_releases where id=_release for share;
  if not found or _review.capture_release_id<>_intent.capture_release_id or _review.worker_sha256 is distinct from _worker
    or _review.retired_at is not null or _review.approved_at>clock_timestamp() or _review.expires_at<=clock_timestamp() then
    raise exception using errcode='42501',message='recording_cleanup_release_required'; end if;
  -- Claiming does not authorize storage or bypass a hold. Worker admission still
  -- checks the complete current release, storage, retention policy and holds.
  perform clinical_private.recording_cleanup_operator(_intent.organization_id);
  _until:=least(clock_timestamp()+interval '5 minutes',_review.expires_at,
    (select expires_at from clinical_private.recording_cleanup_operators where organization_id=_intent.organization_id and operator_id=_actor));
  if _until<=clock_timestamp() then raise exception using errcode='42501',message='recording_cleanup_operator_required'; end if;
  insert into clinical_private.recording_cleanup_runs(id,recording_id,queue_version,cleanup_release_id,worker_sha256,operator_id,lease_until)
    values(_run,_recording,_version,_release,_worker,_actor,_until);
  update clinical_private.recording_cleanup_work set run_id=_run,lease_until=_until where recording_id=_recording;
  return jsonb_build_object('runId',_run,'recordingId',_recording,'version',_version,'claimed',true,'leaseUntil',_until);
end $$;

create function clinical_private.admit_recording_cleanup_run(_recording uuid,_version bigint,_release uuid,_worker text,_run uuid,_attempt uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _admission jsonb; _work clinical_private.recording_cleanup_work; _row clinical_private.recording_cleanup_runs;
begin
  _admission:=case when _attempt is null then clinical_private.admit_recording_cleanup(_recording,_version,_release,_worker)
    else clinical_private.admit_recording_cleanup_attempt(_recording,_version,_release,_worker,_attempt) end;
  select * into strict _work from clinical_private.recording_cleanup_work where recording_id=_recording for share;
  select * into _row from clinical_private.recording_cleanup_runs where id=_run;
  if not found or _work.run_id is distinct from _run or _work.queue_version<>_version or _work.lease_until<=clock_timestamp()
    or _row.recording_id<>_recording or _row.queue_version<>_version or _row.cleanup_release_id<>_release
    or _row.worker_sha256<>_worker or _row.operator_id<>clinical_private.actor_person_id() then
    raise exception using errcode='55000',message='recording_cleanup_run_conflict'; end if;
  return _admission||jsonb_build_object('runId',_run,'validUntil',least((_admission->>'validUntil')::timestamptz,_work.lease_until));
end $$;

create function clinical_private.finish_recording_cleanup_run(_run uuid,_outcome text,_acknowledged integer,_evidence text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.recording_cleanup_operator(clinical_private.organization_id());
  _row clinical_private.recording_cleanup_runs; _work clinical_private.recording_cleanup_work;
  _existing clinical_private.recording_cleanup_run_results; _apply boolean; _next timestamptz; _failures integer;
begin
  select r.* into _row from clinical_private.recording_cleanup_runs r join clinical_private.recording_cleanup_intents i on i.recording_id=r.recording_id
    where r.id=_run and i.organization_id=clinical_private.organization_id() and r.operator_id=_actor;
  if not found then raise exception using errcode='42501',message='recording_cleanup_operator_required'; end if;
  if _outcome is null or _outcome not in ('empty_observed','needs_recheck','held','unavailable','refused')
    or (_acknowledged is null and _outcome not in ('held','unavailable','refused')) or _acknowledged not between 0 and 25
    or (_outcome='empty_observed' and _acknowledged is distinct from 0)
    or _evidence is null or _evidence!~'^[a-f0-9]{64}$' then
    raise exception using errcode='22023',message='recording_cleanup_run_invalid'; end if;
  select * into strict _work from clinical_private.recording_cleanup_work where recording_id=_row.recording_id for update;
  select * into _existing from clinical_private.recording_cleanup_run_results where run_id=_run;
  if found then
    if _existing.outcome<>_outcome or _existing.delete_acknowledged is distinct from _acknowledged or _existing.evidence_sha256<>_evidence then
      raise exception using errcode='55000',message='recording_cleanup_run_conflict'; end if;
  else
    _apply:=_work.run_id=_run and _work.queue_version=_row.queue_version and _work.lease_until>clock_timestamp();
    _apply:=coalesce(_apply,false);
    if _apply then
      _failures:=case when _outcome in ('unavailable','refused') then least(16,_work.consecutive_failures+1) else 0 end;
      _next:=clock_timestamp()+make_interval(secs=>case when _outcome in ('empty_observed','held') then 3600
        when _outcome='needs_recheck' then 30 else least(3600,30*power(2,_failures)::integer) end);
      update clinical_private.recording_cleanup_work set run_id=null,lease_until=null,next_check_at=_next,
        consecutive_failures=_failures,last_outcome=_outcome where recording_id=_row.recording_id;
    end if;
    insert into clinical_private.recording_cleanup_run_results(run_id,outcome,delete_acknowledged,evidence_sha256,applied_to_schedule,next_check_at)
      values(_run,_outcome,_acknowledged,_evidence,_apply,_next) returning * into _existing;
  end if;
  return jsonb_build_object('runId',_run,'recordingId',_row.recording_id,'outcome',_existing.outcome,
    'appliedToSchedule',_existing.applied_to_schedule,'nextCheckAt',_existing.next_check_at,'audioDeleted',false,'requiresRecheck',true);
end $$;

create function clinical_private.list_recording_cleanup_work(_after uuid default null,_limit integer default 25) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform clinical_private.recording_cleanup_operator(clinical_private.organization_id());
  if _limit is null or _limit not between 1 and 100 then raise exception using errcode='22023',message='recording_cleanup_run_invalid'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('recordingId',q.recording_id,'patientRecordId',q.patient_record_id,
    'version',q.version,'reason',q.reason,'dueAt',q.due_at,'nextCheckAt',q.next_check_at,'leaseUntil',q.lease_until,
    'lastOutcome',q.last_outcome,'consecutiveFailures',q.consecutive_failures,'unresolvedAttempts',q.unresolved_attempts,
    'audioDeleted',false,'requiresRecheck',true) order by q.recording_id) from (
      select i.*,w.next_check_at,w.lease_until,w.last_outcome,w.consecutive_failures,
        (select count(*)::integer from clinical_private.recording_cleanup_attempts a where a.recording_id=i.recording_id
          and not exists(select 1 from clinical_private.recording_cleanup_attempt_events e where e.attempt_id=a.id and e.outcome='delete_acknowledged')) unresolved_attempts
      from clinical_private.recording_cleanup_intents i join clinical_private.recording_cleanup_work w on w.recording_id=i.recording_id
      where i.organization_id=clinical_private.organization_id() and (_after is null or i.recording_id>_after)
      order by i.recording_id limit _limit) q),'[]'::jsonb);
end $$;
revoke all on function clinical_private.recording_cleanup_work_trigger(),clinical_private.claim_recording_cleanup_run(uuid,bigint,uuid,text,uuid),
  clinical_private.admit_recording_cleanup_run(uuid,bigint,uuid,text,uuid,uuid),clinical_private.finish_recording_cleanup_run(uuid,text,integer,text),
  clinical_private.list_recording_cleanup_work(uuid,integer) from public,clinical_core_api;
grant execute on function clinical_private.claim_recording_cleanup_run(uuid,bigint,uuid,text,uuid),
  clinical_private.admit_recording_cleanup_run(uuid,bigint,uuid,text,uuid,uuid),clinical_private.finish_recording_cleanup_run(uuid,text,integer,text),
  clinical_private.list_recording_cleanup_work(uuid,integer) to clinical_core_api;
