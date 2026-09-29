-- Synthetic-only text messaging. No external delivery or PHI activation.
create table clinical_core.care_message_threads(
 id uuid primary key default gen_random_uuid(), sequence bigint generated always as identity unique,
 connection_id uuid not null references clinical_core.patient_connections(id),
 subject text not null check(char_length(subject) between 1 and 120),
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp()
);
create table clinical_core.care_messages(
 id uuid primary key default gen_random_uuid(), sequence bigint generated always as identity unique,
 thread_id uuid not null references clinical_core.care_message_threads(id),
 sender_id uuid not null references clinical_core.persons(id), sender_pool text not null check(sender_pool in('consumer','workforce')),
 request_id uuid not null, request_hash text not null, acknowledgement text not null check(acknowledgement='care-messages/1'),
 body text not null check(char_length(body) between 1 and 4000), created_at timestamptz not null default clock_timestamp(),
 unique(sender_id,request_id)
);
create index care_message_threads_connection_sequence on clinical_core.care_message_threads(connection_id,sequence);
create index care_messages_thread_sequence on clinical_core.care_messages(thread_id,sequence);
create table clinical_core.care_message_audit(
 id uuid primary key default gen_random_uuid(),actor_id uuid not null references clinical_core.persons(id),
 organization_id uuid not null references clinical_core.organizations(id),
 action text not null check(action in('list','read','send')),thread_id uuid references clinical_core.care_message_threads(id),
 occurred_at timestamptz not null default clock_timestamp()
);
alter table clinical_core.care_message_threads enable row level security;
alter table clinical_core.care_messages enable row level security;
alter table clinical_core.care_message_audit enable row level security;
revoke all on clinical_core.care_message_threads,clinical_core.care_messages,clinical_core.care_message_audit from public,clinical_core_api;
create trigger care_messages_immutable before update or delete on clinical_core.care_messages for each row execute function clinical_private.block_update_delete();
create trigger care_message_audit_immutable before update or delete on clinical_core.care_message_audit for each row execute function clinical_private.block_update_delete();

create function clinical_core.care_message_request(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 _actor uuid:=clinical_private.actor_person_id(); _org uuid:=clinical_private.organization_id();
 _pool text:=clinical_private.claim('identity_pool'); _action text:=_request->>'action';
 _connection clinical_core.patient_connections%rowtype; _thread clinical_core.care_message_threads%rowtype;
 _message clinical_core.care_messages%rowtype; _items jsonb; _next text; _hash text;
 _before bigint:=coalesce((_request->>'before')::bigint,9223372036854775807);
begin
 perform clinical_private.assert_synthetic_context(_org,'clinical_data');
 if _actor is null or _org is null or _pool is null or _pool not in('consumer','workforce') or
 not exists(select 1 from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
 where i.person_id=_actor and i.identity_pool=_pool and i.identity_subject=clinical_private.claim('identity_subject')
 and i.status='active' and p.status='active' and i.synthetic_attested)
 or not exists(select 1 from clinical_core.organizations where id=_org and status='active')
 or (_pool='workforce' and not clinical_private.has_clinical_role(_org)) then
 raise exception using errcode='42501',message='care_message_refused'; end if;
 if _request is null or jsonb_typeof(_request)<>'object' or octet_length(_request::text)>20480
 or _action is null or _action not in('list','read','send') or _before<1 then
 raise exception using errcode='22023',message='care_message_invalid'; end if;
 if _action='list' then
  if _request-array['action','before']<>'{}'::jsonb then raise exception using errcode='22023',message='care_message_invalid'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('threadId',t.id,'connectionId',c.id,'patientRecordId',c.patient_record_id,
   'sequence',t.sequence::text,'subject',t.subject,'createdAt',t.created_at,'updatedAt',t.updated_at) order by t.sequence desc),'[]'::jsonb)
  into _items from (select t.* from clinical_core.care_message_threads t join clinical_core.patient_connections c on c.id=t.connection_id
   join clinical_core.patient_records p on p.id=c.patient_record_id
   where c.organization_id=_org and c.state='verified' and p.status='active'
   and (_pool='workforce' or c.consumer_person_id=_actor) and t.sequence<_before order by t.sequence desc limit 30) t
   join clinical_core.patient_connections c on c.id=t.connection_id;
  insert into clinical_core.care_message_audit(actor_id,organization_id,action) values(_actor,_org,'list');
  return jsonb_build_object('action','list','threads',_items,'nextBefore',case when jsonb_array_length(_items)=30 then _items->29->>'sequence' else null end);
 end if;
 if _action='read' then
  if _request-array['action','threadId','before']<>'{}'::jsonb then raise exception using errcode='22023',message='care_message_invalid'; end if;
 else
  if _request-array['action','requestId','connectionId','threadId','subject','body','acknowledgement']<>'{}'::jsonb
   or _request->>'acknowledgement' is distinct from 'care-messages/1'
   or jsonb_typeof(_request->'body') is distinct from 'string'
   or coalesce(char_length(btrim(_request->>'body')),0) not between 1 and 4000
   or nullif(_request->>'requestId','') is null or nullif(_request->>'connectionId','') is null then
   raise exception using errcode='22023',message='care_message_invalid'; end if;
 end if;
 if _request ? 'threadId' then
  select * into _thread from clinical_core.care_message_threads where id=(_request->>'threadId')::uuid;
  if not found then raise exception using errcode='42501',message='care_message_refused'; end if;
  select * into _connection from clinical_core.patient_connections where id=_thread.connection_id for update;
 else
  if _action<>'send' or jsonb_typeof(_request->'subject') is distinct from 'string'
  or coalesce(char_length(btrim(_request->>'subject')),0) not between 1 and 120 then
   raise exception using errcode='22023',message='care_message_invalid'; end if;
  select * into _connection from clinical_core.patient_connections where id=(_request->>'connectionId')::uuid for update;
 end if;
 if _connection.id is null or _connection.organization_id<>_org or _connection.state<>'verified'
 or (_pool='consumer' and _connection.consumer_person_id is distinct from _actor)
 or not exists(select 1 from clinical_core.patient_records where id=_connection.patient_record_id and status='active')
 or (_action='send' and (_request->>'connectionId')::uuid is distinct from _connection.id) then
 raise exception using errcode='42501',message='care_message_refused'; end if;
 if _action='read' then
  select coalesce(jsonb_agg(jsonb_build_object('messageId',m.id,'sequence',m.sequence::text,'body',m.body,'sender',m.sender_pool,
    'createdAt',m.created_at) order by m.sequence desc),'[]'::jsonb) into _items
  from(select * from clinical_core.care_messages where thread_id=_thread.id and sequence<_before order by sequence desc limit 50)m;
  insert into clinical_core.care_message_audit(actor_id,organization_id,action,thread_id) values(_actor,_org,'read',_thread.id);
  return jsonb_build_object('action','read','thread',jsonb_build_object('threadId',_thread.id,'connectionId',_connection.id,
   'patientRecordId',_connection.patient_record_id,'sequence',_thread.sequence::text,'subject',_thread.subject,
   'createdAt',_thread.created_at,'updatedAt',_thread.updated_at),'messages',_items,
   'nextBefore',case when jsonb_array_length(_items)=50 then _items->49->>'sequence' else null end);
 end if;
 _hash:=encode(public.digest(convert_to(_request::text,'UTF8'),'sha256'),'hex');
 -- Serialize per sender as well as connection: retry IDs cannot be repurposed across clinics.
 perform pg_advisory_xact_lock(hashtextextended(_actor::text,0));
 select * into _message from clinical_core.care_messages where sender_id=_actor and request_id=(_request->>'requestId')::uuid;
 if found then
  if _message.request_hash<>_hash then raise exception using errcode='40001',message='care_message_conflict'; end if;
  return jsonb_build_object('action','send','threadId',_message.thread_id,'messageId',_message.id,'duplicate',true,'status','stored','receivedAt',_message.created_at);
 end if;
 if _thread.id is null then
  insert into clinical_core.care_message_threads(connection_id,subject) values(_connection.id,btrim(_request->>'subject')) returning * into _thread;
 elsif _request ? 'subject' then raise exception using errcode='22023',message='care_message_invalid'; end if;
 insert into clinical_core.care_messages(thread_id,sender_id,sender_pool,request_id,request_hash,acknowledgement,body)
 values(_thread.id,_actor,_pool,(_request->>'requestId')::uuid,_hash,'care-messages/1',btrim(_request->>'body')) returning * into _message;
 update clinical_core.care_message_threads set updated_at=_message.created_at where id=_thread.id;
 insert into clinical_core.care_message_audit(actor_id,organization_id,action,thread_id) values(_actor,_org,'send',_thread.id);
 return jsonb_build_object('action','send','threadId',_thread.id,'messageId',_message.id,'duplicate',false,'status','stored','receivedAt',_message.created_at);
end $$;
revoke all on function clinical_core.care_message_request(jsonb) from public;
grant execute on function clinical_core.care_message_request(jsonb) to clinical_core_api;
