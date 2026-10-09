-- Metadata-only operator history. This grants no storage or scheduling rights.
create table clinical_private.recording_cleanup_review_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  actor_id uuid not null references clinical_core.persons(id),
  action text not null check(action in ('queue.read','history.read')),
  recording_id uuid references clinical_private.recording_cleanup_intents(recording_id),
  after_id uuid,
  returned_rows integer not null check(returned_rows between 0 and 25),
  created_at timestamptz not null default clock_timestamp(),
  check((action='queue.read' and recording_id is null) or (action='history.read' and recording_id is not null))
);
alter table clinical_private.recording_cleanup_review_events enable row level security;
alter table clinical_private.recording_cleanup_review_events force row level security;
revoke all on clinical_private.recording_cleanup_review_events from public,clinical_core_api;
create trigger recording_cleanup_review_events_immutable before update or delete on clinical_private.recording_cleanup_review_events
  for each row execute function clinical_private.block_update_delete();
create function clinical_private.review_recording_cleanup_work(_after uuid default null,_limit integer default 25) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.recording_cleanup_operator(clinical_private.organization_id()); _result jsonb;
begin
  if _limit is null or _limit not between 1 and 25 then raise exception using errcode='22023',message='recording_cleanup_run_invalid'; end if;
  _result:=clinical_private.list_recording_cleanup_work(_after,_limit);
  insert into clinical_private.recording_cleanup_review_events(organization_id,actor_id,action,after_id,returned_rows)
    values(clinical_private.organization_id(),_actor,'queue.read',_after,jsonb_array_length(_result));
  return _result;
end $$;
revoke all on function clinical_private.review_recording_cleanup_work(uuid,integer) from public,clinical_core_api;
grant execute on function clinical_private.review_recording_cleanup_work(uuid,integer) to clinical_core_api;
create index recording_cleanup_runs_recording_page on clinical_private.recording_cleanup_runs(recording_id,id);
create function clinical_private.list_recording_cleanup_runs(_recording uuid,_after uuid default null,_limit integer default 25) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.recording_cleanup_operator(clinical_private.organization_id()); _result jsonb;
begin
  if _limit is null or _limit not between 1 and 25 then
    raise exception using errcode='22023',message='recording_cleanup_run_invalid'; end if;
  perform 1 from clinical_private.recording_cleanup_intents where recording_id=_recording and organization_id=clinical_private.organization_id();
  if not found then raise exception using errcode='42501',message='recording_cleanup_operator_required'; end if;
  _result:=coalesce((select jsonb_agg(jsonb_build_object('runId',r.id,'version',r.queue_version,
    'claimedAt',r.claimed_at,'leaseUntil',r.lease_until,
    'leaseActive',coalesce(w.run_id=r.id and w.queue_version=r.queue_version and w.lease_until>clock_timestamp(),false),
    'result',case when e.run_id is null then null else jsonb_build_object('outcome',e.outcome,
      'deleteAcknowledged',e.delete_acknowledged,'recordedAt',e.recorded_at,'appliedToSchedule',e.applied_to_schedule,'nextCheckAt',e.next_check_at) end,
    'audioDeleted',false,'requiresRecheck',true) order by r.id)
    from (select * from clinical_private.recording_cleanup_runs where recording_id=_recording and (_after is null or id>_after) order by id limit _limit) r
    join clinical_private.recording_cleanup_work w on w.recording_id=r.recording_id
    left join clinical_private.recording_cleanup_run_results e on e.run_id=r.id),'[]'::jsonb);
  insert into clinical_private.recording_cleanup_review_events(organization_id,actor_id,action,recording_id,after_id,returned_rows)
    values(clinical_private.organization_id(),_actor,'history.read',_recording,_after,jsonb_array_length(_result));
  return _result;
end $$;
revoke all on function clinical_private.list_recording_cleanup_runs(uuid,uuid,integer) from public,clinical_core_api;
grant execute on function clinical_private.list_recording_cleanup_runs(uuid,uuid,integer) to clinical_core_api;
