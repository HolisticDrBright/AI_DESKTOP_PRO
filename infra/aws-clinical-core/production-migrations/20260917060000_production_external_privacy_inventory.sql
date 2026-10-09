-- Read-only external-store inventory. No deletion, approval or assignment seed.
alter table clinical_audit.consumer_storage_events drop constraint consumer_storage_events_action_check;
alter table clinical_audit.consumer_storage_events add constraint consumer_storage_events_action_check check(action in (
  'consent.granted','consent.revoked','record.written','record.deleted','records.listed',
  'active_plan.adopted','active_plan.released','active_plan.record_deleted',
  'privacy_request.submitted','privacy_request.held','privacy_request.fulfillment','privacy_request.completed',
  'privacy_request.tombstoned','privacy_request.purged','legal_hold.placed','legal_hold.released','privacy_request.inventory'));
create table clinical_private.owned_external_inventories(
  id uuid primary key,
  privacy_request_id uuid not null references clinical_private.owned_privacy_requests(id),
  owner_id uuid not null references clinical_core.persons(id),
  owner_subject text not null,
  store text not null check(store in ('labs','voice')),
  source_arn text not null,
  created_by uuid not null references clinical_core.persons(id),
  revision integer not null default 0,
  scanned integer not null default 0,
  item_count integer not null default 0,
  issues integer not null default 0,
  state text not null default 'scanning' check(state in ('scanning','exhausted','bounded')),
  next_cursor jsonb,
  cursor_hashes jsonb not null default '[]',
  evidence_sha256 text not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create index owned_external_inventories_request on clinical_private.owned_external_inventories(privacy_request_id,id);
create table clinical_private.owned_external_inventory_items(
  inventory_id uuid not null references clinical_private.owned_external_inventories(id),
  kind text not null check(kind in ('lab_job','lab_cleanup','voice_job')),
  job_id text not null,
  metadata jsonb not null,
  primary key(inventory_id,kind,job_id)
);
alter table clinical_private.owned_external_inventories enable row level security;
alter table clinical_private.owned_external_inventories force row level security;
alter table clinical_private.owned_external_inventory_items enable row level security;
alter table clinical_private.owned_external_inventory_items force row level security;
revoke all on clinical_private.owned_external_inventories,clinical_private.owned_external_inventory_items from public,clinical_core_api;

create function clinical_private.external_inventory_summary(_i clinical_private.owned_external_inventories)
returns jsonb language sql security definer set search_path='' as $$
  select jsonb_build_object('inventoryId',_i.id,'privacyRequestId',_i.privacy_request_id,'store',_i.store,
    'revision',_i.revision,'scanned',_i.scanned,'items',_i.item_count,'issues',_i.issues,'state',_i.state,
    'sourceSha256',encode(public.digest(_i.source_arn,'sha256'),'hex'),'evidenceSha256',_i.evidence_sha256,
    'createdAt',_i.created_at,'updatedAt',_i.updated_at,'readOnly',true,'completeAccountInventory',false,
    'requiresReconciliation',true)
$$;

-- The trusted worker supplies a deployment-pinned table ARN, never a client path.
-- A held request is readable; an owner being disabled does not erase their data.
create function clinical_private.open_owned_external_inventory(_request_id uuid,_id uuid,_store text,_source text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _r clinical_private.owned_privacy_requests; _i clinical_private.owned_external_inventories; _subject text;
begin
  _r:=clinical_private.lock_owned_privacy_request(_request_id,true);
  if _r.kind<>'deletion' or _id is null or _store not in ('labs','voice') or _store is null
    or _source is null or _source !~ '^arn:aws:dynamodb:[a-z0-9-]+:[0-9]{12}:table/[A-Za-z0-9_.-]{3,255}$' then
    raise exception using errcode='22023',message='external_inventory_invalid';
  end if;
  select identity_subject into _subject from clinical_core.identities
    where person_id=_r.owner_id and identity_pool='consumer' and production_bound=true for share;
  if not found then raise exception using errcode='42501',message='privacy_operator_assignment_required'; end if;
  insert into clinical_private.owned_external_inventories(id,privacy_request_id,owner_id,owner_subject,store,source_arn,created_by,evidence_sha256)
    values(_id,_request_id,_r.owner_id,_subject,_store,_source,clinical_private.privacy_operator(),
      encode(public.digest(_request_id::text||':'||_id::text||':'||_subject||':'||_source,'sha256'),'hex')) on conflict do nothing;
  select * into _i from clinical_private.owned_external_inventories where id=_id for update;
  if _i.privacy_request_id<>_request_id or _i.owner_id<>_r.owner_id or _i.owner_subject<>_subject
    or _i.store<>_store or _i.source_arn<>_source then
    raise exception using errcode='40001',message='external_inventory_conflict';
  end if;
  return jsonb_build_object('ownerId',_i.owner_id,'ownerSub',_i.owner_subject,'cursor',_i.next_cursor,
    'summary',clinical_private.external_inventory_summary(_i));
end $$;

create function clinical_private.append_owned_external_inventory(_id uuid,_revision integer,_items jsonb,_cursor jsonb,_scanned integer,_issues integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _i clinical_private.owned_external_inventories; _r clinical_private.owned_privacy_requests;
  _row jsonb; _cursor_hash text; _subject text; _keys text[];
begin
  select * into _i from clinical_private.owned_external_inventories where id=_id;
  if not found then raise exception using errcode='22023',message='external_inventory_invalid'; end if;
  _r:=clinical_private.lock_owned_privacy_request(_i.privacy_request_id,true);
  select * into _i from clinical_private.owned_external_inventories where id=_id for update;
  select identity_subject into _subject from clinical_core.identities
    where person_id=_r.owner_id and identity_pool='consumer' and production_bound=true for share;
  if _subject is distinct from _i.owner_subject or _r.kind<>'deletion' or _i.revision is distinct from _revision or _i.state<>'scanning' then
    raise exception using errcode='40001',message='external_inventory_conflict';
  end if;
  if _scanned is null or _scanned not between 0 and 25 or _issues is null or _issues not between 0 and _scanned
    or _items is null or jsonb_typeof(_items)<>'array' or jsonb_array_length(_items)+_issues>_scanned
    or octet_length(_items::text)>100000 then
    raise exception using errcode='22023',message='external_inventory_invalid';
  end if;
  if _cursor is not null then
    if jsonb_typeof(_cursor)<>'object' or octet_length(_cursor::text)>1024 or _scanned=0 then
      raise exception using errcode='22023',message='external_inventory_invalid';
    end if;
    _cursor_hash:=encode(public.digest(_cursor::text,'sha256'),'hex');
    if _i.cursor_hashes ? _cursor_hash then raise exception using errcode='40001',message='external_inventory_conflict'; end if;
  end if;
  for _row in select value from jsonb_array_elements(_items) loop
    if jsonb_typeof(_row)<>'object' then raise exception using errcode='22023',message='external_inventory_invalid'; end if;
    select array_agg(key order by key) into _keys from jsonb_object_keys(_row) key;
    if _keys is distinct from array['jobId','kind','organizationId','ownerSub','state','updatedAt']
      or _row->>'ownerSub' is distinct from _i.owner_subject
      or coalesce(_row->>'organizationId','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
      or not ((_i.store='labs' and _row->>'kind' in ('lab_job','lab_cleanup') and coalesce(_row->>'jobId','') ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$')
        or (_i.store='voice' and _row->>'kind'='voice_job' and coalesce(_row->>'jobId','') ~ '^[a-f0-9]{64}$'))
      or coalesce(length(_row->>'state'),0) not between 1 and 40
      or jsonb_typeof(_row->'updatedAt') not in ('string','null') then
      raise exception using errcode='22023',message='external_inventory_invalid';
    end if;
    if exists(select 1 from clinical_private.owned_external_inventory_items where inventory_id=_id
      and kind=_row->>'kind' and job_id=_row->>'jobId') then
      raise exception using errcode='40001',message='external_inventory_conflict';
    end if;
    insert into clinical_private.owned_external_inventory_items values(_id,_row->>'kind',_row->>'jobId',_row);
  end loop;
  update clinical_private.owned_external_inventories set revision=revision+1,scanned=scanned+_scanned,
    item_count=item_count+jsonb_array_length(_items),issues=issues+_issues,next_cursor=_cursor,
    cursor_hashes=case when _cursor is null then cursor_hashes else cursor_hashes||jsonb_build_array(_cursor_hash) end,
    evidence_sha256=encode(public.digest(evidence_sha256||':'||_items::text||':'||coalesce(_cursor::text,'null')||':'||_scanned::text||':'||_issues::text,'sha256'),'hex'),
    state=case when _cursor is null then 'exhausted' when scanned+_scanned>=100000 or item_count+jsonb_array_length(_items)>=10000 or revision+1>=10000 then 'bounded' else 'scanning' end,
    updated_at=clock_timestamp() where id=_id returning * into _i;
  insert into clinical_audit.consumer_storage_events(owner_id,action,scope) values(_i.owner_id,'privacy_request.inventory','privacy');
  return clinical_private.external_inventory_summary(_i);
end $$;
revoke all on function clinical_private.external_inventory_summary(clinical_private.owned_external_inventories),
  clinical_private.open_owned_external_inventory(uuid,uuid,text,text),
  clinical_private.append_owned_external_inventory(uuid,integer,jsonb,jsonb,integer,integer) from public;
grant execute on function clinical_private.open_owned_external_inventory(uuid,uuid,text,text),
  clinical_private.append_owned_external_inventory(uuid,integer,jsonb,jsonb,integer,integer) to clinical_core_api;

-- Reuse the existing queue authority; expose only the latest 20 count/hash
-- summaries, never job identifiers, identity subjects or raw Dynamo cursors.
alter function clinical_private.get_assigned_privacy_request(uuid) rename to get_assigned_privacy_request_v1;
revoke all on function clinical_private.get_assigned_privacy_request_v1(uuid) from public,clinical_core_api;
create function clinical_private.get_assigned_privacy_request(_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _detail jsonb; _inventories jsonb;
begin
  _detail:=clinical_private.get_assigned_privacy_request_v1(_id);
  select coalesce(jsonb_agg(clinical_private.external_inventory_summary(i) order by i.created_at desc,i.id),'[]'::jsonb)
    into _inventories from (select * from clinical_private.owned_external_inventories
      where privacy_request_id=_id order by created_at desc,id limit 20) i;
  return _detail||jsonb_build_object('externalInventories',_inventories);
end $$;
revoke all on function clinical_private.get_assigned_privacy_request(uuid) from public;
grant execute on function clinical_private.get_assigned_privacy_request(uuid) to clinical_core_api;
