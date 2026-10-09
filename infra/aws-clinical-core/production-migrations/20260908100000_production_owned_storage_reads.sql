-- Reviewed copy is returned exactly, with its digest, before consent is granted.
alter table clinical_private.consumer_storage_consent_releases drop constraint consumer_storage_consent_releases_scope_check;
alter table clinical_private.consumer_storage_consent_releases add constraint consumer_storage_consent_releases_scope_check
  check(scope in ('forms_checkins','symptoms_adherence','nutrition','protocols_supplements','wearables','reproductive_health','ai_context'));
alter table clinical_private.consumer_storage_consent_releases
  add column content text not null check (length(content) between 1 and 12000),
  add constraint consumer_storage_release_digest check (content_sha256=encode(public.digest(content,'sha256'),'hex'));

create function clinical_core.get_owned_storage_consent_state(_scope text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _release jsonb; _current jsonb; _history jsonb;
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management'
    or _scope is null or _scope not in ('forms_checkins','symptoms_adherence','nutrition','protocols_supplements','wearables','reproductive_health','ai_context') then
    raise exception using errcode='22023',message='consent_request_invalid';
  end if;
  select jsonb_build_object('version',version,'content',content,'contentSha256',content_sha256,'approvedAt',approved_at)
    into _release from clinical_private.consumer_storage_consent_releases
    where scope=_scope and retired_at is null and approved_at<=clock_timestamp()
    order by approved_at desc,version desc limit 1;
  select jsonb_build_object('revision',revision,'status',status,'releaseVersion',release_version,'recordedAt',recorded_at)
    into _current from clinical_core.consumer_storage_consents where owner_id=_actor and scope=_scope
    order by revision desc limit 1;
  select coalesce(jsonb_agg(to_jsonb(c) order by c.revision desc),'[]'::jsonb) into _history
    from (select revision,status,release_version as "releaseVersion",recorded_at as "recordedAt"
      from clinical_core.consumer_storage_consents where owner_id=_actor and scope=_scope order by revision desc limit 100) c;
  return jsonb_build_object('scope',_scope,'release',_release,'current',_current,'history',_history,
    'historyLimit',100,'activeRevision',clinical_private.owned_consumer_consent(_actor,_scope));
end $$;

-- Point reads include the latest tombstone/revision for safe optimistic writes.
create function clinical_core.get_owned_consumer_record(_collection text,_record_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _scope text; _record jsonb;
begin
  _scope:=clinical_private.consumer_collection_scope(_collection);
  if clinical_private.claim('purpose') is distinct from 'clinical_data' or _scope is null or _record_id is null then
    raise exception using errcode='22023',message='owned_record_request_invalid';
  end if;
  if clinical_private.owned_consumer_consent(_actor,_scope) is null then
    raise exception using errcode='42501',message='consumer_storage_consent_required';
  end if;
  select jsonb_build_object('recordId',record_id,'revision',revision,'payload',payload,'deleted',deleted,'receivedAt',received_at)
    into _record from clinical_core.owned_consumer_record_versions
    where owner_id=_actor and collection=_collection and record_id=_record_id order by revision desc limit 1;
  insert into clinical_audit.consumer_storage_events(owner_id,action,scope,collection,record_id)
    values(_actor,'records.listed',_scope,_collection,_record_id);
  return _record;
end $$;
revoke all on function clinical_core.get_owned_storage_consent_state(text),clinical_core.get_owned_consumer_record(text,uuid) from public;
grant execute on function clinical_core.get_owned_storage_consent_state(text),clinical_core.get_owned_consumer_record(text,uuid) to clinical_core_api;

create function clinical_core.recent_owned_consumer_records(_collection text,_limit integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _scope text:=clinical_private.consumer_collection_scope(_collection); _result jsonb;
begin
  if clinical_private.claim('purpose') is distinct from 'clinical_data' or _scope is null or _limit is null or _limit<1 or _limit>100 then
    raise exception using errcode='22023',message='owned_record_request_invalid';
  end if;
  if clinical_private.owned_consumer_consent(_actor,_scope) is null then raise exception using errcode='42501',message='consumer_storage_consent_required'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('recordId',r.record_id,'revision',r.revision,'payload',r.payload,'receivedAt',r.received_at) order by r.received_at desc,r.record_id),'[]'::jsonb)
    into _result from (select * from (select distinct on (record_id) * from clinical_core.owned_consumer_record_versions
      where owner_id=_actor and collection=_collection order by record_id,revision desc) latest
    where not deleted order by received_at desc,record_id limit _limit) r;
  insert into clinical_audit.consumer_storage_events(owner_id,action,scope,collection) values(_actor,'records.listed',_scope,_collection);
  return _result;
end $$;
revoke all on function clinical_core.recent_owned_consumer_records(text,integer) from public;
grant execute on function clinical_core.recent_owned_consumer_records(text,integer) to clinical_core_api;
