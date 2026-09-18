-- Owner-scoped privacy request ledger (deletion / correction) with per-store
-- fulfillment records, workforce-placed legal holds and a reviewed retention
-- policy gate. Submission survives consent withdrawal. Consumer self-service
-- deletion tombstones every live personal record; physical purge of retained
-- history requires an approved retention policy and a workforce operator.
-- Nothing here erases lab objects, voice objects, identity or backups: those
-- stores are fulfilled by separate, attributable operations and recorded here.

create table clinical_private.owned_retention_policies (
  version text primary key check (version ~ '^[A-Za-z0-9._/-]{1,80}$'),
  content text not null check (char_length(content) between 1 and 12000),
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  approved_by text not null check (char_length(approved_by) between 1 and 200),
  approved_at timestamptz not null,
  retired_at timestamptz
);
create table clinical_private.owned_legal_holds (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references clinical_core.persons(id),
  reason_code text not null check (reason_code in ('litigation','regulatory_inquiry','security_investigation','owner_dispute')),
  placed_by uuid not null references clinical_core.persons(id),
  placed_at timestamptz not null default clock_timestamp(),
  released_by uuid references clinical_core.persons(id),
  released_at timestamptz,
  check ((released_by is null)=(released_at is null))
);
create index owned_legal_holds_active on clinical_private.owned_legal_holds(owner_id) where released_at is null;
create table clinical_private.owned_privacy_requests (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references clinical_core.persons(id),
  request_id uuid not null,
  kind text not null check (kind in ('deletion','correction')),
  status text not null check (status in ('submitted','held','in_progress','completed','refused')),
  correction jsonb check (correction is null or (jsonb_typeof(correction)='object' and octet_length(correction::text)<=8192)),
  submitted_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  unique(owner_id, request_id),
  check ((kind='correction')=(correction is not null))
);
create index owned_privacy_requests_owner_time on clinical_private.owned_privacy_requests(owner_id, submitted_at desc);
create table clinical_private.owned_privacy_fulfillment (
  id bigint generated always as identity primary key,
  privacy_request_id uuid not null references clinical_private.owned_privacy_requests(id),
  store text not null check (store in ('personal_records','personal_consents','active_plan','lab_jobs_and_documents',
    'voice_jobs_and_transcripts','identity','clinic_records','device_caches_and_recovery_archives','backups_and_audit')),
  outcome text not null check (outcome in ('tombstoned','purged','not_applicable','pending','refused','not_enumerable','retained_by_policy')),
  evidence_sha256 text check (evidence_sha256 is null or evidence_sha256 ~ '^[a-f0-9]{64}$'),
  operator text not null check (char_length(operator) between 1 and 200),
  recorded_at timestamptz not null default clock_timestamp()
);
create index owned_privacy_fulfillment_request on clinical_private.owned_privacy_fulfillment(privacy_request_id, recorded_at, id);
alter table clinical_private.owned_retention_policies enable row level security;
alter table clinical_private.owned_retention_policies force row level security;
alter table clinical_private.owned_legal_holds enable row level security;
alter table clinical_private.owned_legal_holds force row level security;
alter table clinical_private.owned_privacy_requests enable row level security;
alter table clinical_private.owned_privacy_requests force row level security;
alter table clinical_private.owned_privacy_fulfillment enable row level security;
alter table clinical_private.owned_privacy_fulfillment force row level security;
revoke all on clinical_private.owned_retention_policies,clinical_private.owned_legal_holds,
  clinical_private.owned_privacy_requests,clinical_private.owned_privacy_fulfillment from public,clinical_core_api;

alter table clinical_audit.consumer_storage_events drop constraint if exists consumer_storage_events_action_check;
alter table clinical_audit.consumer_storage_events add constraint consumer_storage_events_action_check check (action in (
  'consent.granted','consent.revoked','record.written','record.deleted','records.listed',
  'active_plan.adopted','active_plan.released','active_plan.record_deleted',
  'privacy_request.submitted','privacy_request.held','privacy_request.fulfillment','privacy_request.completed',
  'privacy_request.tombstoned','privacy_request.purged','legal_hold.placed','legal_hold.released'));

-- Workforce operators are revalidated against an active workforce identity;
-- an operator never acts as a consumer and a consumer never fulfils requests.
create function clinical_private.privacy_operator()
returns uuid language plpgsql stable security definer set search_path='' as $$
declare _actor uuid:=clinical_private.actor_person_id();
begin
  if clinical_private.claim('identity_pool') is distinct from 'workforce'
    or clinical_private.claim('purpose') is distinct from 'consent_management'
    or clinical_private.claim('environment') is distinct from 'production-clinical'
    or not exists(select 1 from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
      where i.person_id=_actor and i.identity_pool='workforce' and i.identity_subject=clinical_private.claim('identity_subject')
        and i.status='active' and p.status='active') then
    raise exception using errcode='42501',message='privacy_operator_required';
  end if;
  return _actor;
end $$;

create function clinical_private.owned_privacy_request_json(_owner uuid,_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('privacyRequestId',r.id,'requestId',r.request_id,'kind',r.kind,'status',r.status,
    'submittedAt',r.submitted_at,'updatedAt',r.updated_at,'completedAt',r.completed_at,
    'legalHold',exists(select 1 from clinical_private.owned_legal_holds h where h.owner_id=r.owner_id and h.released_at is null),
    'fulfillment',(select coalesce(jsonb_agg(jsonb_build_object('store',f.store,'outcome',f.outcome,'evidenceSha256',f.evidence_sha256,'recordedAt',f.recorded_at)
      order by f.recorded_at,f.id),'[]'::jsonb) from clinical_private.owned_privacy_fulfillment f where f.privacy_request_id=r.id))
  from clinical_private.owned_privacy_requests r where r.owner_id=_owner and r.id=_id
$$;

create function clinical_core.submit_owned_privacy_request(_request_id uuid,_kind text,_correction jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _saved clinical_private.owned_privacy_requests; _held boolean;
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management' or _request_id is null
    or _kind is null or _kind not in ('deletion','correction') or ((_kind='correction')<>(_correction is not null)) then
    raise exception using errcode='22023',message='privacy_request_invalid';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(_actor::text,0));
  select * into _saved from clinical_private.owned_privacy_requests where owner_id=_actor and request_id=_request_id;
  if found then
    if _saved.kind<>_kind or _saved.correction is distinct from _correction then
      raise exception using errcode='40001',message='privacy_request_conflict';
    end if;
    return clinical_private.owned_privacy_request_json(_actor,_saved.id)||jsonb_build_object('duplicate',true);
  end if;
  if _kind='deletion' and exists(select 1 from clinical_private.owned_privacy_requests
      where owner_id=_actor and kind='deletion' and status in ('submitted','held','in_progress')) then
    raise exception using errcode='40001',message='privacy_request_conflict';
  end if;
  _held:=exists(select 1 from clinical_private.owned_legal_holds where owner_id=_actor and released_at is null);
  insert into clinical_private.owned_privacy_requests(owner_id,request_id,kind,status,correction)
    values(_actor,_request_id,_kind,case when _held then 'held' else 'submitted' end,_correction) returning * into _saved;
  insert into clinical_audit.consumer_storage_events(owner_id,action,scope)
    values(_actor,case when _held then 'privacy_request.held' else 'privacy_request.submitted' end,'privacy');
  return clinical_private.owned_privacy_request_json(_actor,_saved.id)||jsonb_build_object('duplicate',false);
end $$;

create function clinical_core.list_owned_privacy_requests()
returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor();
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management' then
    raise exception using errcode='22023',message='privacy_request_invalid';
  end if;
  return (select coalesce(jsonb_agg(clinical_private.owned_privacy_request_json(_actor,r.id) order by r.submitted_at desc,r.id),'[]'::jsonb)
    from (select id,submitted_at from clinical_private.owned_privacy_requests where owner_id=_actor order by submitted_at desc limit 50) r);
end $$;

-- Consumer self-service deletion of personal records: a tombstone revision for
-- every live record, under the same lock as ordinary writes, recorded against
-- the request. Tombstones keep history; they are not physical erasure.
create function clinical_core.tombstone_owned_personal_records(_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _request clinical_private.owned_privacy_requests;
  _row record; _count integer:=0; _consent integer; _command uuid;
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management' or _request_id is null then
    raise exception using errcode='22023',message='privacy_request_invalid';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(_actor::text,0));
  select * into _request from clinical_private.owned_privacy_requests where owner_id=_actor and request_id=_request_id and kind='deletion';
  if not found then raise exception using errcode='22023',message='privacy_request_invalid'; end if;
  if _request.status='held' or exists(select 1 from clinical_private.owned_legal_holds where owner_id=_actor and released_at is null) then
    raise exception using errcode='42501',message='privacy_request_held';
  end if;
  if _request.status in ('completed','refused') then
    raise exception using errcode='40001',message='privacy_request_conflict';
  end if;
  for _row in select distinct on (collection,record_id) collection,record_id,revision,deleted
      from clinical_core.owned_consumer_record_versions where owner_id=_actor order by collection,record_id,revision desc loop
    if not _row.deleted then
      select max(revision) into _consent from clinical_core.consumer_storage_consents
        where owner_id=_actor and scope=clinical_private.consumer_collection_scope(_row.collection);
      _command:=gen_random_uuid();
      insert into clinical_core.owned_consumer_record_versions
        (owner_id,collection,record_id,revision,request_id,command_sha256,payload,deleted,consent_revision)
        values(_actor,_row.collection,_row.record_id,_row.revision+1,_command,
          encode(public.digest(jsonb_build_array('privacy_tombstone',_request.id,_row.collection,_row.record_id,_row.revision+1)::text,'sha256'),'hex'),
          '{}'::jsonb,true,coalesce(_consent,1));
      _count:=_count+1;
    end if;
  end loop;
  update clinical_private.owned_privacy_requests set status='in_progress',updated_at=clock_timestamp() where id=_request.id and status='submitted';
  insert into clinical_private.owned_privacy_fulfillment(privacy_request_id,store,outcome,evidence_sha256,operator)
    values(_request.id,'personal_records','tombstoned',encode(public.digest(jsonb_build_array(_request.id,_count)::text,'sha256'),'hex'),'owner_self_service'),
      (_request.id,'active_plan',case when exists(select 1 from clinical_core.owned_consumer_active_plans where owner_id=_actor) then 'pending' else 'tombstoned' end,null,'owner_self_service');
  insert into clinical_audit.consumer_storage_events(owner_id,action,scope) values(_actor,'privacy_request.tombstoned','privacy');
  return clinical_private.owned_privacy_request_json(_actor,_request.id)||jsonb_build_object('tombstoned',_count);
end $$;

create function clinical_private.place_owned_legal_hold(_owner uuid,_reason text)
returns uuid language plpgsql security definer set search_path='' as $$
declare _operator uuid:=clinical_private.privacy_operator(); _id uuid;
begin
  if _owner is null or _reason is null then raise exception using errcode='22023',message='legal_hold_invalid'; end if;
  perform pg_advisory_xact_lock(hashtextextended(_owner::text,0));
  insert into clinical_private.owned_legal_holds(owner_id,reason_code,placed_by) values(_owner,_reason,_operator) returning id into _id;
  update clinical_private.owned_privacy_requests set status='held',updated_at=clock_timestamp()
    where owner_id=_owner and kind='deletion' and status in ('submitted','in_progress');
  insert into clinical_audit.consumer_storage_events(owner_id,action,scope) values(_owner,'legal_hold.placed','privacy');
  return _id;
end $$;

create function clinical_private.release_owned_legal_hold(_hold uuid)
returns void language plpgsql security definer set search_path='' as $$
declare _operator uuid:=clinical_private.privacy_operator(); _hold_row clinical_private.owned_legal_holds;
begin
  select * into _hold_row from clinical_private.owned_legal_holds where id=_hold and released_at is null;
  if not found then raise exception using errcode='22023',message='legal_hold_invalid'; end if;
  perform pg_advisory_xact_lock(hashtextextended(_hold_row.owner_id::text,0));
  update clinical_private.owned_legal_holds set released_by=_operator,released_at=clock_timestamp() where id=_hold;
  if not exists(select 1 from clinical_private.owned_legal_holds where owner_id=_hold_row.owner_id and released_at is null) then
    update clinical_private.owned_privacy_requests set status='submitted',updated_at=clock_timestamp() where owner_id=_hold_row.owner_id and status='held';
  end if;
  insert into clinical_audit.consumer_storage_events(owner_id,action,scope) values(_hold_row.owner_id,'legal_hold.released','privacy');
end $$;

create function clinical_private.record_owned_privacy_fulfillment(_privacy_request uuid,_store text,_outcome text,_evidence text)
returns void language plpgsql security definer set search_path='' as $$
declare _operator uuid:=clinical_private.privacy_operator(); _request clinical_private.owned_privacy_requests;
begin
  select * into _request from clinical_private.owned_privacy_requests where id=_privacy_request;
  if not found or _request.status in ('completed','refused') then raise exception using errcode='22023',message='privacy_request_invalid'; end if;
  if _request.status='held' and _outcome in ('purged','tombstoned') then raise exception using errcode='42501',message='privacy_request_held'; end if;
  insert into clinical_private.owned_privacy_fulfillment(privacy_request_id,store,outcome,evidence_sha256,operator)
    values(_privacy_request,_store,_outcome,_evidence,'workforce:'||_operator::text);
  update clinical_private.owned_privacy_requests set status=case when status='submitted' then 'in_progress' else status end,updated_at=clock_timestamp() where id=_privacy_request;
  insert into clinical_audit.consumer_storage_events(owner_id,action,scope) values(_request.owner_id,'privacy_request.fulfillment','privacy');
end $$;

-- Completion needs every store recorded with a terminal outcome and no hold.
-- A pending or unrecorded store keeps the request open; nothing is inferred.
create function clinical_private.complete_owned_privacy_request(_privacy_request uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _operator uuid:=clinical_private.privacy_operator(); _request clinical_private.owned_privacy_requests; _missing text;
begin
  select * into _request from clinical_private.owned_privacy_requests where id=_privacy_request;
  if not found or _request.status in ('completed','refused') then raise exception using errcode='22023',message='privacy_request_invalid'; end if;
  if _request.status='held' or exists(select 1 from clinical_private.owned_legal_holds where owner_id=_request.owner_id and released_at is null) then
    raise exception using errcode='42501',message='privacy_request_held';
  end if;
  if _request.kind='deletion' then
    select s into _missing from unnest(array['personal_records','personal_consents','active_plan','lab_jobs_and_documents',
      'voice_jobs_and_transcripts','identity','clinic_records','device_caches_and_recovery_archives','backups_and_audit']) s
      where not exists(select 1 from (select distinct on (store) store,outcome from clinical_private.owned_privacy_fulfillment
        where privacy_request_id=_privacy_request order by store,recorded_at desc,id desc) latest
        where latest.store=s and latest.outcome<>'pending') limit 1;
    if _missing is not null then raise exception using errcode='40001',message='privacy_request_store_pending'; end if;
  end if;
  update clinical_private.owned_privacy_requests set status='completed',completed_at=clock_timestamp(),updated_at=clock_timestamp() where id=_privacy_request;
  insert into clinical_audit.consumer_storage_events(owner_id,action,scope) values(_request.owner_id,'privacy_request.completed','privacy');
  return clinical_private.owned_privacy_request_json(_request.owner_id,_privacy_request);
end $$;

-- Physical purge of retained personal history. Refused without an approved,
-- unretired retention policy and a non-held, in-progress deletion request.
create function clinical_private.purge_owned_personal_history(_privacy_request uuid,_policy_version text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _operator uuid:=clinical_private.privacy_operator(); _request clinical_private.owned_privacy_requests;
  _policy clinical_private.owned_retention_policies; _records bigint; _consents bigint; _plans bigint;
begin
  select * into _policy from clinical_private.owned_retention_policies where version=_policy_version and retired_at is null;
  if not found then raise exception using errcode='42501',message='retention_policy_required'; end if;
  select * into _request from clinical_private.owned_privacy_requests where id=_privacy_request and kind='deletion';
  if not found or _request.status<>'in_progress' then raise exception using errcode='22023',message='privacy_request_invalid'; end if;
  if exists(select 1 from clinical_private.owned_legal_holds where owner_id=_request.owner_id and released_at is null) then
    raise exception using errcode='42501',message='privacy_request_held';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(_request.owner_id::text,0));
  delete from clinical_core.owned_consumer_active_plan_history where owner_id=_request.owner_id;
  delete from clinical_core.owned_consumer_active_plans where owner_id=_request.owner_id;
  get diagnostics _plans=row_count;
  delete from clinical_core.owned_consumer_record_versions where owner_id=_request.owner_id;
  get diagnostics _records=row_count;
  delete from clinical_core.consumer_storage_consents where owner_id=_request.owner_id;
  get diagnostics _consents=row_count;
  insert into clinical_private.owned_privacy_fulfillment(privacy_request_id,store,outcome,evidence_sha256,operator) values
    (_privacy_request,'personal_records','purged',encode(public.digest(jsonb_build_array(_privacy_request,'records',_records,_policy.content_sha256)::text,'sha256'),'hex'),'workforce:'||_operator::text),
    (_privacy_request,'personal_consents','purged',encode(public.digest(jsonb_build_array(_privacy_request,'consents',_consents,_policy.content_sha256)::text,'sha256'),'hex'),'workforce:'||_operator::text),
    (_privacy_request,'active_plan','purged',encode(public.digest(jsonb_build_array(_privacy_request,'plans',_plans,_policy.content_sha256)::text,'sha256'),'hex'),'workforce:'||_operator::text);
  insert into clinical_audit.consumer_storage_events(owner_id,action,scope) values(_request.owner_id,'privacy_request.purged','privacy');
  return jsonb_build_object('privacyRequestId',_privacy_request,'records',_records,'consents',_consents,'activePlans',_plans,'policyVersion',_policy.version);
end $$;

revoke all on function clinical_private.privacy_operator(),clinical_private.owned_privacy_request_json(uuid,uuid),
  clinical_core.submit_owned_privacy_request(uuid,text,jsonb),clinical_core.list_owned_privacy_requests(),
  clinical_core.tombstone_owned_personal_records(uuid),
  clinical_private.place_owned_legal_hold(uuid,text),clinical_private.release_owned_legal_hold(uuid),
  clinical_private.record_owned_privacy_fulfillment(uuid,text,text,text),clinical_private.complete_owned_privacy_request(uuid),
  clinical_private.purge_owned_personal_history(uuid,text) from public;
grant execute on function clinical_core.submit_owned_privacy_request(uuid,text,jsonb),clinical_core.list_owned_privacy_requests(),
  clinical_core.tombstone_owned_personal_records(uuid),
  clinical_private.place_owned_legal_hold(uuid,text),clinical_private.release_owned_legal_hold(uuid),
  clinical_private.record_owned_privacy_fulfillment(uuid,text,text,text),clinical_private.complete_owned_privacy_request(uuid),
  clinical_private.purge_owned_personal_history(uuid,text) to clinical_core_api;
