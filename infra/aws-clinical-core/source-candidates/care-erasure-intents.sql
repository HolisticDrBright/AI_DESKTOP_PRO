-- BLOCKED SYNTHETIC SOURCE CANDIDATE. Not registered in either migration ledger.
-- Requires the exact correlated-erasure predecessor; execute only through a
-- future reviewed preserving operator, in one transaction. No apply tool exists.
create table clinical_core.care_data_erasure_intents (
 owner_id uuid not null references clinical_core.persons(id),request_id uuid not null,
 scope text not null check(scope in('domain','account_closure')),
 registered_at timestamptz not null default clock_timestamp(),primary key(owner_id,request_id)
);
alter table clinical_core.care_data_erasure_intents enable row level security;
revoke all on clinical_core.care_data_erasure_intents from public,clinical_core_api;
create trigger care_data_erasure_intents_immutable before update or delete
 on clinical_core.care_data_erasure_intents for each row execute function clinical_private.care_data_immutable();

create function clinical_private.care_erasure_locked_owner() returns uuid
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.actor_person_id(); _org uuid:=clinical_private.organization_id();
begin
 perform clinical_private.assert_synthetic_context(_org,'consent_management');
 if _actor is null or clinical_private.claim('identity_pool')<>'consumer'
 or not exists(select 1 from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
  where i.person_id=_actor and i.identity_pool='consumer' and i.identity_subject=clinical_private.claim('identity_subject')
   and i.status='active' and p.status='active' and i.synthetic_attested) then
  raise exception using errcode='42501',message='care_data_forbidden'; end if;
 perform pg_advisory_xact_lock(hashtextextended(_actor::text,0));
 return _actor;
end $$;
revoke all on function clinical_private.care_erasure_locked_owner() from public,clinical_core_api;

create function clinical_core.care_data_prepare_erasure(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.care_erasure_locked_owner(); _scope text:=_request->>'scope'; _id uuid;
 _prior clinical_core.care_data_erasure_requests%rowtype; _intent clinical_core.care_data_erasure_intents%rowtype;
begin
 if _request is null or clinical_private.jsonb_kind(_request)<>'object'
 or _request-array['action','scope','requestId']<>'{}'::jsonb
 or (_request->>'action') is distinct from 'prepare_erasure' or _scope is null or _scope not in('domain','account_closure')
 or coalesce(_request->>'requestId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
  raise exception using errcode='22023',message='care_data_invalid'; end if;
 _id:=(_request->>'requestId')::uuid;
 select * into _prior from clinical_core.care_data_erasure_requests where owner_id=_actor and request_id=_id;
 if found then
  if _prior.scope<>_scope then raise exception using errcode='23505',message='care_data_conflict'; end if;
  return jsonb_build_object('action','prepare_erasure','requestId',_id,'scope',_scope,'outcome',_prior.outcome,'receipt',_prior.receipt);
 end if;
 select * into _intent from clinical_core.care_data_erasure_intents where owner_id=_actor and request_id=_id;
 if found then
  if _intent.scope<>_scope then raise exception using errcode='23505',message='care_data_conflict'; end if;
 else
  insert into clinical_core.care_data_erasure_intents(owner_id,request_id,scope) values(_actor,_id,_scope);
 end if;
 return jsonb_build_object('action','prepare_erasure','requestId',_id,'scope',_scope,'outcome','prepared','receipt',null);
end $$;
revoke all on function clinical_core.care_data_prepare_erasure(jsonb) from public;
grant execute on function clinical_core.care_data_prepare_erasure(jsonb) to clinical_core_api;

-- Preserve the exact predecessor, but remove its direct API authority. Only the
-- guarded wrapper can invoke it; read/settlement still reconcile old UUIDs.
alter function clinical_core.care_data_erasure_request(jsonb) rename to care_data_erasure_request_v1_terminal;
revoke all on function clinical_core.care_data_erasure_request_v1_terminal(jsonb) from public,clinical_core_api;
create function clinical_core.care_data_erasure_request(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.care_erasure_locked_owner(); _scope text:=_request->>'scope'; _id uuid; _intent_scope text;
begin
 if (_request->>'action')='erase_request' then
  if _request is null or clinical_private.jsonb_kind(_request)<>'object'
   or _request-array['action','scope','requestId']<>'{}'::jsonb or _scope is null or _scope not in('domain','account_closure')
   or coalesce(_request->>'requestId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
   raise exception using errcode='22023',message='care_data_invalid'; end if;
  _id:=(_request->>'requestId')::uuid;
  if not exists(select 1 from clinical_core.care_data_erasure_requests where owner_id=_actor and request_id=_id) then
   select scope into _intent_scope from clinical_core.care_data_erasure_intents where owner_id=_actor and request_id=_id;
   if not found then raise exception using errcode='22023',message='care_erasure_intent_required'; end if;
   if _intent_scope<>_scope then raise exception using errcode='23505',message='care_data_conflict'; end if;
  end if;
 end if;
 return clinical_core.care_data_erasure_request_v1_terminal(_request);
end $$;
revoke all on function clinical_core.care_data_erasure_request(jsonb) from public;
grant execute on function clinical_core.care_data_erasure_request(jsonb) to clinical_core_api;

create function clinical_core.care_data_discover_erasures(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.care_erasure_locked_owner(); _limit integer:=50; _after uuid;
 _row record; _items jsonb:='[]'::jsonb; _next uuid; _last uuid; _count integer:=0; _legacy bigint;
begin
 if _request is null or clinical_private.jsonb_kind(_request)<>'object'
 or _request-array['action','limit','after']<>'{}'::jsonb
 or (_request->>'action') is distinct from 'discover_erasure_requests' then
  raise exception using errcode='22023',message='care_data_invalid'; end if;
 if _request?'limit' then
  if clinical_private.jsonb_kind(_request->'limit')<>'number' or (_request->>'limit') !~ '^[0-9]{1,3}$' then
   raise exception using errcode='22023',message='care_data_invalid'; end if;
  _limit:=(_request->>'limit')::integer;
  if _limit<1 or _limit>100 then raise exception using errcode='22023',message='care_data_invalid'; end if;
 end if;
 if _request?'after' then
  if coalesce(_request->>'after','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
   raise exception using errcode='22023',message='care_data_invalid'; end if;
  _after:=(_request->>'after')::uuid;
 end if;
 for _row in
  select q.* from (
   select i.request_id,i.scope,coalesce(r.outcome,'prepared') as outcome,r.receipt,
    true as intent_registered,i.registered_at,r.settled_at as completed_at
   from clinical_core.care_data_erasure_intents i left join clinical_core.care_data_erasure_requests r
    on r.owner_id=i.owner_id and r.request_id=i.request_id where i.owner_id=_actor
   union all
   select r.request_id,r.scope,r.outcome,r.receipt,false,null::timestamptz,r.settled_at
   from clinical_core.care_data_erasure_requests r where r.owner_id=_actor and not exists
    (select 1 from clinical_core.care_data_erasure_intents i where i.owner_id=r.owner_id and i.request_id=r.request_id)
  ) q where _after is null or q.request_id>_after order by q.request_id limit _limit+1
 loop
  if _count=_limit then _next:=_last; exit; end if;
  _items:=_items||jsonb_build_array(jsonb_build_object('requestId',_row.request_id,'scope',_row.scope,
   'outcome',_row.outcome,'receipt',_row.receipt,'intentRegistered',_row.intent_registered,
   'registeredAt',_row.registered_at,'completedAt',_row.completed_at));
  _count:=_count+1; _last:=_row.request_id;
 end loop;
 select count(*) into _legacy from clinical_core.care_data_erasures e where e.owner_id=_actor and not exists
  (select 1 from clinical_core.care_data_erasure_requests r where r.owner_id=_actor and r.outcome='erased' and r.receipt->>'erasureId'=e.id::text);
 return jsonb_build_object('action','discover_erasure_requests','items',_items,'next',_next,
  'legacyUncorrelatedErasureCount',_legacy,'coverage','committed_owner_records_not_global_clearance');
end $$;
revoke all on function clinical_core.care_data_discover_erasures(jsonb) from public;
grant execute on function clinical_core.care_data_discover_erasures(jsonb) to clinical_core_api;
