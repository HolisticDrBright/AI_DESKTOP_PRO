-- Operator-led purge of inventoried external lab/voice jobs and reviewed request
-- completion. Nothing outside a finished inventory is touched; every remote
-- mutation still passes the owner hold/identity guard; a bounded inventory can
-- never prove a store empty. No assignments, approvals or activation are seeded.
alter table clinical_audit.consumer_storage_events drop constraint consumer_storage_events_action_check;
alter table clinical_audit.consumer_storage_events add constraint consumer_storage_events_action_check check(action in (
  'consent.granted','consent.revoked','record.written','record.deleted','records.listed',
  'active_plan.adopted','active_plan.released','active_plan.record_deleted',
  'privacy_request.submitted','privacy_request.held','privacy_request.fulfillment','privacy_request.completed',
  'privacy_request.tombstoned','privacy_request.purged','legal_hold.placed','legal_hold.released','privacy_request.inventory','privacy_request.external_purge'));

create table clinical_private.owned_external_purge_items(
  inventory_id uuid not null,
  kind text not null check(kind in ('lab_job','lab_cleanup','voice_job')),
  job_id text not null,
  state text not null check(state in ('claimed','cleaned','not_found','refused')),
  attempts integer not null default 1 check(attempts between 1 and 1000),
  detail text not null check(length(detail) between 1 and 120),
  updated_at timestamptz not null default clock_timestamp(),
  primary key(inventory_id,kind,job_id),
  foreign key(inventory_id,kind,job_id) references clinical_private.owned_external_inventory_items(inventory_id,kind,job_id)
);
alter table clinical_private.owned_external_purge_items enable row level security;
alter table clinical_private.owned_external_purge_items force row level security;
revoke all on clinical_private.owned_external_purge_items from public,clinical_core_api;

create function clinical_private.external_purge_summary(_i clinical_private.owned_external_inventories)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _cleaned bigint; _not_found bigint; _refused bigint; _claimed bigint; _remaining bigint; _evidence text;
begin
  select count(*) filter(where state='cleaned'),count(*) filter(where state='not_found'),
    count(*) filter(where state='refused'),count(*) filter(where state='claimed')
    into _cleaned,_not_found,_refused,_claimed from clinical_private.owned_external_purge_items where inventory_id=_i.id;
  _remaining:=_i.item_count-_cleaned-_not_found;
  select encode(public.digest(coalesce(string_agg(kind||':'||job_id||':'||state||':'||attempts::text,',' order by kind collate "C",job_id collate "C"),'')||':'||_i.evidence_sha256,'sha256'),'hex')
    into _evidence from clinical_private.owned_external_purge_items where inventory_id=_i.id;
  return jsonb_build_object('inventoryId',_i.id,'privacyRequestId',_i.privacy_request_id,'store',_i.store,
    'inventoryState',_i.state,'total',_i.item_count,'cleaned',_cleaned,'notFound',_not_found,'refused',_refused,'claimed',_claimed,
    'remaining',_remaining,'state',case when _i.state='scanning' then 'inventory_incomplete' when _remaining=0 then 'complete' else 'in_progress' end,
    'evidenceSha256',_evidence,'updatedAt',clock_timestamp(),'completeStorePurge',false);
end $$;

-- Returns the next bounded batch of inventoried items that are not yet terminal,
-- with the owner scope every remote mutation must be guarded by. Refuses held
-- requests and unfinished inventories; the trusted worker never chooses ids.
create function clinical_private.begin_owned_external_purge(_request_id uuid,_inventory_id uuid,_limit integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _r clinical_private.owned_privacy_requests; _i clinical_private.owned_external_inventories; _subject text; _items jsonb;
begin
  _r:=clinical_private.lock_owned_privacy_request(_request_id,false);
  if _r.kind<>'deletion' or _inventory_id is null or _limit is null or _limit not between 1 and 10 then
    raise exception using errcode='22023',message='external_purge_invalid';
  end if;
  select * into _i from clinical_private.owned_external_inventories where id=_inventory_id for update;
  if not found or _i.privacy_request_id<>_request_id or _i.owner_id<>_r.owner_id then
    raise exception using errcode='22023',message='external_purge_invalid';
  end if;
  if _i.state='scanning' then raise exception using errcode='40001',message='external_inventory_incomplete'; end if;
  select identity_subject into _subject from clinical_core.identities
    where person_id=_r.owner_id and identity_pool='consumer' and production_bound=true for share;
  if not found or _subject<>_i.owner_subject then raise exception using errcode='42501',message='privacy_operator_assignment_required'; end if;
  with due as (
    select it.kind,it.job_id,it.metadata,coalesce(p.attempts,0) as attempts
      from clinical_private.owned_external_inventory_items it
      left join clinical_private.owned_external_purge_items p
        on p.inventory_id=it.inventory_id and p.kind=it.kind and p.job_id=it.job_id
      where it.inventory_id=_inventory_id and (p.state is null or p.state in ('claimed','refused'))
      order by it.kind collate "C",it.job_id collate "C" limit _limit)
  select coalesce(jsonb_agg(jsonb_build_object('kind',kind,'jobId',job_id,'organizationId',metadata->>'organizationId',
    'inventoryState',metadata->>'state','attempts',attempts) order by kind collate "C",job_id collate "C"),'[]'::jsonb) into _items from due;
  update clinical_private.owned_privacy_requests set status='in_progress',updated_at=clock_timestamp() where id=_request_id and status='submitted';
  insert into clinical_audit.consumer_storage_events(owner_id,action,scope) values(_r.owner_id,'privacy_request.external_purge','privacy');
  return jsonb_build_object('ownerId',_r.owner_id,'ownerSub',_subject,'items',_items,'summary',clinical_private.external_purge_summary(_i));
end $$;

-- Records what the guarded remote mutation reported. Terminal outcomes are
-- immutable; a refusal may be recorded while held so the ledger shows why.
create function clinical_private.record_owned_external_purge_item(_inventory_id uuid,_kind text,_job_id text,_state text,_detail text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _i clinical_private.owned_external_inventories; _r clinical_private.owned_privacy_requests;
begin
  select * into _i from clinical_private.owned_external_inventories where id=_inventory_id;
  if not found then raise exception using errcode='22023',message='external_purge_invalid'; end if;
  _r:=clinical_private.lock_owned_privacy_request(_i.privacy_request_id,true);
  select * into _i from clinical_private.owned_external_inventories where id=_inventory_id for update;
  if _state is null or _state not in ('claimed','cleaned','not_found','refused') or _detail is null or length(_detail) not between 1 and 120
    or not exists(select 1 from clinical_private.owned_external_inventory_items where inventory_id=_inventory_id and kind=_kind and job_id=_job_id) then
    raise exception using errcode='22023',message='external_purge_invalid';
  end if;
  if _state='cleaned' and (_r.status='held' or exists(select 1 from clinical_private.owned_legal_holds where owner_id=_r.owner_id and released_at is null)) then
    raise exception using errcode='42501',message='privacy_request_held';
  end if;
  insert into clinical_private.owned_external_purge_items(inventory_id,kind,job_id,state,detail) values(_inventory_id,_kind,_job_id,_state,_detail)
    on conflict(inventory_id,kind,job_id) do update set state=excluded.state,detail=excluded.detail,
      attempts=least(clinical_private.owned_external_purge_items.attempts+1,1000),updated_at=clock_timestamp()
    where clinical_private.owned_external_purge_items.state not in ('cleaned','not_found');
  return clinical_private.external_purge_summary(_i);
end $$;

-- Store fulfillment follows only from a finished inventory whose every item
-- reached a terminal outcome. An exhausted inventory with items is purged: the
-- documents, audio and transcripts are gone; only metadata watch tombstones
-- remain, governed by retention. An empty exhausted inventory is not applicable.
-- A bounded inventory may have missed rows and can only be pending.
create function clinical_private.finish_owned_external_purge(_request_id uuid,_inventory_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _r clinical_private.owned_privacy_requests; _i clinical_private.owned_external_inventories; _summary jsonb; _store text; _outcome text;
begin
  _r:=clinical_private.lock_owned_privacy_request(_request_id,false);
  select * into _i from clinical_private.owned_external_inventories where id=_inventory_id for update;
  if not found or _i.privacy_request_id<>_request_id or _r.kind<>'deletion' then
    raise exception using errcode='22023',message='external_purge_invalid';
  end if;
  _summary:=clinical_private.external_purge_summary(_i);
  if _i.state='scanning' or (_summary->>'remaining')::bigint<>0 then
    raise exception using errcode='40001',message='external_purge_incomplete';
  end if;
  _store:=case _i.store when 'labs' then 'lab_jobs_and_documents' else 'voice_jobs_and_transcripts' end;
  _outcome:=case when _i.state<>'exhausted' then 'pending' when _i.item_count=0 then 'not_applicable' else 'purged' end;
  perform clinical_private.record_owned_privacy_fulfillment(_request_id,_store,_outcome,_summary->>'evidenceSha256');
  return _summary||jsonb_build_object('fulfillmentStore',_store,'fulfillmentOutcome',_outcome);
end $$;

revoke all on function clinical_private.external_purge_summary(clinical_private.owned_external_inventories),
  clinical_private.begin_owned_external_purge(uuid,uuid,integer),
  clinical_private.record_owned_external_purge_item(uuid,text,text,text,text),
  clinical_private.finish_owned_external_purge(uuid,uuid) from public;
grant execute on function clinical_private.begin_owned_external_purge(uuid,uuid,integer),
  clinical_private.record_owned_external_purge_item(uuid,text,text,text,text),
  clinical_private.finish_owned_external_purge(uuid,uuid) to clinical_core_api;
