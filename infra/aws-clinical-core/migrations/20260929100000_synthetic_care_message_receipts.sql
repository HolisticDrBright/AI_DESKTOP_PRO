-- Read-only, consumer-owned recovery metadata. No production activation or message content.
alter table clinical_core.care_message_audit drop constraint care_message_audit_action_check;
alter table clinical_core.care_message_audit add constraint care_message_audit_action_check check(action in('list','read','send','receipt'));

create function clinical_core.care_message_receipt(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 _actor uuid:=clinical_private.actor_person_id(); _org uuid:=clinical_private.organization_id();
 _connection clinical_core.patient_connections%rowtype; _message_id uuid; _thread_id uuid;
 _request_id uuid; _connection_id uuid;
begin
 perform clinical_private.assert_synthetic_context(_org,'clinical_data');
 if _actor is null or _org is null or clinical_private.claim('identity_pool') is distinct from 'consumer'
 or not exists(select 1 from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
  where i.person_id=_actor and i.identity_pool='consumer' and i.identity_subject=clinical_private.claim('identity_subject')
  and i.status='active' and p.status='active' and i.synthetic_attested)
 or not exists(select 1 from clinical_core.organizations where id=_org and status='active') then
  raise exception using errcode='42501',message='care_message_refused'; end if;
 if _request is null or jsonb_typeof(_request)<>'object' or octet_length(_request::text)>1024
 or _request->>'action' is distinct from 'receipt' or _request-array['action','requestId','connectionId']<>'{}'::jsonb
 or jsonb_typeof(_request->'requestId') is distinct from 'string'
 or jsonb_typeof(_request->'connectionId') is distinct from 'string'
 or (_request->>'requestId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 or (_request->>'connectionId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
  raise exception using errcode='22023',message='care_message_invalid'; end if;
 _request_id:=(_request->>'requestId')::uuid; _connection_id:=(_request->>'connectionId')::uuid;
 -- Coordinate with send and connection revocation. This is a point-in-time receipt,
 -- not a promise that a still-pending send will never commit after this lookup.
 select * into _connection from clinical_core.patient_connections where id=_connection_id for share;
 if _connection.id is null or _connection.organization_id<>_org or _connection.state<>'verified'
 or _connection.consumer_person_id is distinct from _actor
 or not exists(select 1 from clinical_core.patient_records where id=_connection.patient_record_id and organization_id=_org and status='active') then
  raise exception using errcode='42501',message='care_message_refused'; end if;
 select m.id,m.thread_id into _message_id,_thread_id from clinical_core.care_messages m
 join clinical_core.care_message_threads t on t.id=m.thread_id
 where m.sender_id=_actor and m.sender_pool='consumer' and m.request_id=_request_id and t.connection_id=_connection_id;
 insert into clinical_core.care_message_audit(actor_id,organization_id,action,thread_id) values(_actor,_org,'receipt',_thread_id);
 if _message_id is null then
  return jsonb_build_object('action','receipt','requestId',_request_id,'connectionId',_connection_id,'status','unresolved');
 end if;
 return jsonb_build_object('action','receipt','requestId',_request_id,'connectionId',_connection_id,
  'status','committed','threadId',_thread_id,'messageId',_message_id);
end $$;
revoke all on function clinical_core.care_message_receipt(jsonb) from public;
grant execute on function clinical_core.care_message_receipt(jsonb) to clinical_core_api;
