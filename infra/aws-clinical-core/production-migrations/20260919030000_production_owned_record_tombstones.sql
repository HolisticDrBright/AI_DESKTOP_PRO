-- Other-device deletion reconciliation. A device that still holds a copy of a
-- record the owner removed elsewhere has no way to learn about it: listing
-- returns only live records. This exposes the owner's tombstones (latest
-- version deleted) without any payload, under the same identity, purpose and
-- consent checks as listing. It changes no data and infers no erasure of
-- device copies, backups or other stores.
create function clinical_core.list_owned_consumer_tombstones(_collection text,_limit integer,
  _after_time timestamptz default null,_after_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _records jsonb;
begin
  if clinical_private.claim('purpose') is distinct from 'clinical_data'
    or _limit is null or _limit<1 or _limit>100 or ((_after_time is null)<>(_after_id is null)) then
    raise exception using errcode='22023',message='owned_record_request_invalid';
  end if;
  if clinical_private.owned_consumer_consent(_actor,clinical_private.consumer_collection_scope(_collection)) is null then
    raise exception using errcode='42501',message='consumer_storage_consent_required';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('recordId',r.record_id,'revision',r.revision,
    'deleted',true,'receivedAt',r.received_at) order by r.received_at,r.record_id),'[]'::jsonb) into _records
  from (select * from (select distinct on (record_id) * from clinical_core.owned_consumer_record_versions
      where owner_id=_actor and collection=_collection order by record_id,revision desc) latest
    where deleted and (_after_time is null or (received_at,record_id)>(_after_time,_after_id))
    order by received_at,record_id limit _limit) r;
  insert into clinical_audit.consumer_storage_events(owner_id,action,scope,collection)
    values(_actor,'records.listed',clinical_private.consumer_collection_scope(_collection),_collection);
  return _records;
end $$;

revoke all on function clinical_core.list_owned_consumer_tombstones(text,integer,timestamptz,uuid) from public;
grant execute on function clinical_core.list_owned_consumer_tombstones(text,integer,timestamptz,uuid) to clinical_core_api;
