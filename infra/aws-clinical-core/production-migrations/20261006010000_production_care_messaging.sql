-- Care messaging contract over the preserved 103-migration predecessor.
-- No release, consent, identity or data is seeded; serving stays separately gated.
-- Patient messages use the existing clinical inbox, rather than a second inbox.
-- Stored in-app communication is a retained clinical record. This candidate
-- supplies owner export, but deliberately supplies no direct erasure function.

alter table clinical_core.messages drop constraint messages_status_check;
alter table clinical_core.messages add constraint messages_status_check
  check(status in ('draft','cancelled','queued','sent','failed','stored'));

create table clinical_core.care_message_thread_links (
  conversation_id uuid primary key references clinical_core.conversations(id),
  connection_id uuid not null references clinical_core.patient_connections(id),
  consumer_person_id uuid not null references clinical_core.persons(id),
  sequence bigint generated always as identity unique
);
create index care_message_thread_links_connection on clinical_core.care_message_thread_links(connection_id,sequence);
create index care_message_thread_links_owner on clinical_core.care_message_thread_links(consumer_person_id,sequence);
create table clinical_core.care_message_receipts (
  sender_id uuid not null references clinical_core.persons(id),
  request_id uuid not null,
  conversation_id uuid not null references clinical_core.care_message_thread_links(conversation_id),
  message_id uuid not null unique references clinical_core.messages(id),
  sender_pool text not null check(sender_pool in ('consumer','workforce')),
  command_sha256 text not null check(command_sha256 ~ '^[a-f0-9]{64}$'),
  sequence bigint generated always as identity unique,
  primary key(sender_id,request_id)
);
create index care_message_receipts_conversation on clinical_core.care_message_receipts(conversation_id,sequence);
create table clinical_core.care_message_cancellations (
  sender_id uuid not null references clinical_core.persons(id),
  request_id uuid not null,
  connection_id uuid not null references clinical_core.patient_connections(id),
  sequence bigint generated always as identity unique,
  settled_at timestamptz not null default clock_timestamp(),
  primary key(sender_id,request_id)
);
create index care_message_cancellations_connection on clinical_core.care_message_cancellations(connection_id);
do $$ declare _table text; begin
  foreach _table in array array['care_message_thread_links','care_message_receipts','care_message_cancellations'] loop
    execute format('alter table clinical_core.%I enable row level security',_table);
    execute format('alter table clinical_core.%I force row level security',_table);
    execute format('revoke all on clinical_core.%I from public,clinical_core_api',_table);
  end loop;
end $$;
create trigger care_message_receipts_immutable before update or delete on clinical_core.care_message_receipts
  for each row execute function clinical_private.block_update_delete();
create trigger care_message_cancellations_immutable before update or delete on clinical_core.care_message_cancellations
  for each row execute function clinical_private.block_update_delete();
create trigger care_message_thread_links_immutable before update or delete on clinical_core.care_message_thread_links
  for each row execute function clinical_private.block_update_delete();

-- Lists and settlement may have no visible thread: do not force a fabricated
-- conversation id into the canonical per-conversation audit table.
create table clinical_audit.care_message_access_events (
  id uuid primary key default public.gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  actor_person_id uuid not null references clinical_core.persons(id),
  action text not null check(action in ('list','read','receipt','settle','export')),
  occurred_at timestamptz not null default clock_timestamp()
);
create index care_message_access_events_org_time on clinical_audit.care_message_access_events(organization_id,occurred_at);
create index care_message_access_events_actor on clinical_audit.care_message_access_events(actor_person_id);
alter table clinical_audit.care_message_access_events enable row level security;
alter table clinical_audit.care_message_access_events force row level security;
revoke all on clinical_audit.care_message_access_events from public,clinical_core_api;
create trigger care_message_access_events_immutable before update or delete on clinical_audit.care_message_access_events
  for each row execute function clinical_private.block_update_delete();

create function clinical_private.production_care_message_actor() returns uuid
language plpgsql stable security definer set search_path='' as $$
declare _actor uuid:=clinical_private.actor_person_id(); _org uuid:=clinical_private.organization_id();
  _pool text:=clinical_private.claim('identity_pool');
begin
  if _actor is null or _org is null or _pool is null or _pool not in ('consumer','workforce')
    or clinical_private.claim('environment') is distinct from 'production-clinical'
    or clinical_private.claim('data_classification') is distinct from 'clinical_phi'
    or clinical_private.claim('purpose') is distinct from 'clinical_data'
    or not exists(select 1 from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
      where i.person_id=_actor and i.identity_subject=clinical_private.claim('identity_subject')
        and i.identity_pool=_pool and i.production_bound and i.status='active' and p.status='active')
    or not exists(select 1 from clinical_core.organizations where id=_org and status='active')
    or (_pool='workforce' and not clinical_private.has_clinical_role(_org)) then
    raise exception using errcode='42501',message='care_message_refused';
  end if;
  return _actor;
end $$;
revoke all on function clinical_private.production_care_message_actor() from public;

create function clinical_private.production_care_message_consent(_connection uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from
    (select * from clinical_core.consent_grants where connection_id=_connection and scope='messaging'
      order by version desc limit 1) g
    join clinical_core.consent_artifacts a on a.id=g.artifact_id and a.organization_id=g.organization_id
    where g.status='granted' and a.status='approved' and a.scope='messaging'
      and a.approved_at<=clock_timestamp())
$$;
revoke all on function clinical_private.production_care_message_consent(uuid) from public;

-- Every receipt insertion uses the same serialization point as settle, including
-- a future insertion path which forgot to take the lock itself.
create function clinical_private.production_care_message_admission() returns trigger
language plpgsql security definer set search_path='' as $$
declare _connection clinical_core.patient_connections%rowtype;
begin
  -- Same lock order as send/settle: connection before owner. Consent withdrawal
  -- and connection replacement must not race an admitted record.
  select c.* into _connection from clinical_core.patient_connections c
    join clinical_core.care_message_thread_links l on l.connection_id=c.id
    where l.conversation_id=new.conversation_id for update of c;
  perform pg_advisory_xact_lock(hashtextextended(new.sender_id::text,0));
  if new.sender_pool='consumer' then perform clinical_private.assert_owned_storage_writable(new.sender_id); end if;
  if exists(select 1 from clinical_core.care_message_cancellations
    where sender_id=new.sender_id and request_id=new.request_id) then
    raise exception using errcode='40001',message='care_message_settled';
  end if;
  if clinical_private.production_care_message_actor() is distinct from new.sender_id
    or clinical_private.claim('identity_pool') is distinct from new.sender_pool
    or _connection.id is null or _connection.state<>'verified'
    or _connection.organization_id is distinct from clinical_private.organization_id()
    or (new.sender_pool='consumer' and _connection.consumer_person_id is distinct from new.sender_id)
    or not exists(select 1 from clinical_core.patient_records where id=_connection.patient_record_id and status='active') then
    raise exception using errcode='42501',message='care_message_refused'; end if;
  if not clinical_private.production_care_message_consent(_connection.id) then
    raise exception using errcode='42501',message='care_message_consent_required'; end if;
  if not exists(select 1 from clinical_core.messages m
    join clinical_core.conversations t on t.id=m.conversation_id
    join clinical_core.care_message_thread_links l on l.conversation_id=t.id
    join clinical_core.patient_connections c on c.id=l.connection_id
    where m.id=new.message_id and m.conversation_id=new.conversation_id
      and m.sender_person_id=new.sender_id and m.status='stored' and m.channel='alp_in_app'
      and char_length(m.body) between 1 and 4000 and char_length(t.subject) between 1 and 120
      and m.organization_id=t.organization_id and t.organization_id=c.organization_id
      and t.patient_record_id=c.patient_record_id and l.consumer_person_id=c.consumer_person_id) then
    raise exception using errcode='42501',message='care_message_refused';
  end if;
  return new;
end $$;
revoke all on function clinical_private.production_care_message_admission() from public;
create trigger care_message_receipt_admission before insert on clinical_core.care_message_receipts
  for each row execute function clinical_private.production_care_message_admission();

create function clinical_private.production_care_message_immutable() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if old.status='stored' or exists(select 1 from clinical_core.care_message_receipts where message_id=old.id) then
    raise exception using errcode='55000',message='append_only_record';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
revoke all on function clinical_private.production_care_message_immutable() from public;
create trigger stored_care_messages_immutable before update or delete on clinical_core.messages
  for each row execute function clinical_private.production_care_message_immutable();

create function clinical_core.production_care_message_request(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  _actor uuid:=clinical_private.production_care_message_actor(); _org uuid:=clinical_private.organization_id();
  _pool text:=clinical_private.claim('identity_pool'); _action text; _before bigint:=9223372036854775807;
  _connection clinical_core.patient_connections%rowtype; _thread clinical_core.conversations%rowtype;
  _link clinical_core.care_message_thread_links%rowtype; _receipt clinical_core.care_message_receipts%rowtype;
  _items jsonb; _hash text; _message uuid; _received timestamptz;
  _row jsonb; _last text; _count integer:=0; _bytes integer:=2; _more boolean:=false;
begin
  if _request is null or jsonb_typeof(_request) is distinct from 'object' or octet_length(_request::text)>20480 then
    raise exception using errcode='22023',message='care_message_invalid'; end if;
  _action:=_request->>'action';
  if _action is null or _action not in ('list','read','send') then
    raise exception using errcode='22023',message='care_message_invalid'; end if;
  if _request ? 'before' then
    if jsonb_typeof(_request->'before') is distinct from 'string' or _request->>'before' !~ '^[1-9][0-9]{0,17}$' then
      raise exception using errcode='22023',message='care_message_invalid'; end if;
    _before:=(_request->>'before')::bigint;
  end if;
  if _action='list' then
    if _request-array['action','before']<>'{}'::jsonb then raise exception using errcode='22023',message='care_message_invalid'; end if;
    select coalesce(jsonb_agg(item order by seq desc),'[]'::jsonb) into _items from (
      select l.sequence as seq,jsonb_build_object('threadId',t.id,'connectionId',c.id,'patientRecordId',c.patient_record_id,
        'sequence',l.sequence::text,'subject',t.subject,'createdAt',t.created_at,'updatedAt',t.updated_at) as item
      from clinical_core.care_message_thread_links l join clinical_core.conversations t on t.id=l.conversation_id
      join clinical_core.patient_connections c on c.id=l.connection_id
      join clinical_core.patient_records p on p.id=c.patient_record_id
      where c.organization_id=_org and t.organization_id=_org and t.patient_record_id=c.patient_record_id
        and c.state='verified' and p.status='active' and (_pool='workforce' or c.consumer_person_id=_actor)
        and l.consumer_person_id=c.consumer_person_id
        and clinical_private.production_care_message_consent(c.id) and l.sequence<_before
      order by l.sequence desc limit 30) page;
    insert into clinical_audit.care_message_access_events(organization_id,actor_person_id,action) values(_org,_actor,'list');
    return jsonb_build_object('action','list','threads',_items,
      'nextBefore',case when jsonb_array_length(_items)=30 then _items->29->>'sequence' else null end);
  end if;
  if _action='read' then
    if _request-array['action','threadId','before']<>'{}'::jsonb then raise exception using errcode='22023',message='care_message_invalid'; end if;
  elsif _request-array['action','requestId','connectionId','threadId','subject','body','acknowledgement']<>'{}'::jsonb
    or _request->>'acknowledgement' is distinct from 'care-messages/1'
    or jsonb_typeof(_request->'body') is distinct from 'string'
    or coalesce(char_length(btrim(_request->>'body')),0) not between 1 and 4000 then
    raise exception using errcode='22023',message='care_message_invalid';
  end if;
  if _request ? 'threadId' then
    if jsonb_typeof(_request->'threadId') is distinct from 'string' or _request->>'threadId' !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' then
      raise exception using errcode='22023',message='care_message_invalid'; end if;
    select t.* into _thread from clinical_core.conversations t join clinical_core.care_message_thread_links l on l.conversation_id=t.id
      where t.id=(_request->>'threadId')::uuid;
    if not found then raise exception using errcode='42501',message='care_message_refused'; end if;
    select * into _link from clinical_core.care_message_thread_links where conversation_id=_thread.id;
    select * into _connection from clinical_core.patient_connections where id=_link.connection_id for update;
  else
    if _action<>'send' or jsonb_typeof(_request->'subject') is distinct from 'string'
      or coalesce(char_length(btrim(_request->>'subject')),0) not between 1 and 120 then
      raise exception using errcode='22023',message='care_message_invalid'; end if;
  end if;
  if _action='send' then
    if jsonb_typeof(_request->'connectionId') is distinct from 'string' or jsonb_typeof(_request->'requestId') is distinct from 'string'
      or _request->>'connectionId' !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
      or _request->>'requestId' !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
      or (_request ? 'threadId' and _request ? 'subject') then
      raise exception using errcode='22023',message='care_message_invalid'; end if;
    if _connection.id is null then
      select * into _connection from clinical_core.patient_connections where id=(_request->>'connectionId')::uuid for update;
    end if;
  end if;
  if _connection.id is null or _connection.organization_id<>_org or _connection.state<>'verified'
    or (_link.conversation_id is not null and _link.consumer_person_id is distinct from _connection.consumer_person_id)
    or (_pool='consumer' and _connection.consumer_person_id is distinct from _actor)
    or not exists(select 1 from clinical_core.patient_records where id=_connection.patient_record_id and organization_id=_org and status='active')
    or (_action='send' and (_request->>'connectionId')::uuid is distinct from _connection.id) then
    raise exception using errcode='42501',message='care_message_refused'; end if;
  if not clinical_private.production_care_message_consent(_connection.id) then
    raise exception using errcode='42501',message='care_message_consent_required'; end if;
  if _action='read' then
    _items:='[]'::jsonb;
    for _row in
      select jsonb_build_object('messageId',m.id,'sequence',r.sequence::text,'body',m.body,
        'sender',r.sender_pool,'createdAt',m.created_at)
      from clinical_core.care_message_receipts r join clinical_core.messages m on m.id=r.message_id
      where r.conversation_id=_thread.id and r.sequence<_before order by r.sequence desc limit 51
    loop
      if _count>=50 or _bytes+octet_length(_row::text)+1>131072 then _more:=true; exit; end if;
      _items:=_items||jsonb_build_array(_row); _bytes:=_bytes+octet_length(_row::text)+1;
      _last:=_row->>'sequence'; _count:=_count+1;
    end loop;
    if _more and _count=0 then raise exception using errcode='22023',message='care_message_invalid'; end if;
    insert into clinical_core.conversation_events(organization_id,conversation_id,action,actor_person_id) values(_org,_thread.id,'care.read',_actor);
    return jsonb_build_object('action','read','thread',jsonb_build_object('threadId',_thread.id,'connectionId',_connection.id,
      'patientRecordId',_connection.patient_record_id,'sequence',_link.sequence::text,'subject',_thread.subject,
      'createdAt',_thread.created_at,'updatedAt',_thread.updated_at),'messages',_items,
      'nextBefore',case when _more then _last else null end);
  end if;
  _hash:=encode(public.digest(convert_to(_request::text,'UTF8'),'sha256'),'hex');
  perform pg_advisory_xact_lock(hashtextextended(_actor::text,0));
  select * into _receipt from clinical_core.care_message_receipts where sender_id=_actor and request_id=(_request->>'requestId')::uuid;
  if found then
    if _receipt.command_sha256<>_hash then raise exception using errcode='40001',message='care_message_conflict'; end if;
    select created_at into _received from clinical_core.messages where id=_receipt.message_id;
    return jsonb_build_object('action','send','threadId',_receipt.conversation_id,'messageId',_receipt.message_id,
      'duplicate',true,'status','stored','receivedAt',_received);
  end if;
  if exists(select 1 from clinical_core.care_message_cancellations where sender_id=_actor and request_id=(_request->>'requestId')::uuid) then
    raise exception using errcode='40001',message='care_message_settled'; end if;
  if _pool='consumer' then perform clinical_private.assert_owned_storage_writable(_actor); end if;
  if _thread.id is null then
    insert into clinical_core.conversations(organization_id,patient_record_id,subject,category,priority,created_by_person_id)
      values(_org,_connection.patient_record_id,btrim(_request->>'subject'),'patient_app','medium',_actor) returning * into _thread;
    insert into clinical_core.care_message_thread_links(conversation_id,connection_id,consumer_person_id)
      values(_thread.id,_connection.id,_connection.consumer_person_id);
  end if;
  insert into clinical_core.messages(organization_id,conversation_id,sender_person_id,body,status,channel)
    values(_org,_thread.id,_actor,btrim(_request->>'body'),'stored','alp_in_app') returning id,created_at into _message,_received;
  insert into clinical_core.care_message_receipts(sender_id,request_id,conversation_id,message_id,sender_pool,command_sha256)
    values(_actor,(_request->>'requestId')::uuid,_thread.id,_message,_pool,_hash);
  update clinical_core.conversations set last_message_at=_received,updated_at=_received,version=version+1 where id=_thread.id;
  insert into clinical_core.conversation_events(organization_id,conversation_id,message_id,action,actor_person_id)
    values(_org,_thread.id,_message,'care.stored',_actor);
  return jsonb_build_object('action','send','threadId',_thread.id,'messageId',_message,'duplicate',false,'status','stored','receivedAt',_received);
end $$;

create function clinical_core.production_care_message_resolve(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.production_care_message_actor(); _org uuid:=clinical_private.organization_id();
  _action text; _request_id uuid; _connection_id uuid; _connection clinical_core.patient_connections%rowtype;
  _receipt clinical_core.care_message_receipts%rowtype; _actual_connection uuid; _accessible boolean;
begin
  if clinical_private.claim('identity_pool') is distinct from 'consumer' then raise exception using errcode='42501',message='care_message_refused'; end if;
  if _request is null or jsonb_typeof(_request) is distinct from 'object' or octet_length(_request::text)>1024
    or _request-array['action','requestId','connectionId']<>'{}'::jsonb
    or jsonb_typeof(_request->'requestId') is distinct from 'string' or jsonb_typeof(_request->'connectionId') is distinct from 'string'
    or _request->>'requestId' !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
    or _request->>'connectionId' !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
    or _request->>'action' is null or _request->>'action' not in ('receipt','settle') then
    raise exception using errcode='22023',message='care_message_invalid'; end if;
  _action:=_request->>'action'; _request_id:=(_request->>'requestId')::uuid; _connection_id:=(_request->>'connectionId')::uuid;
  select * into _connection from clinical_core.patient_connections where id=_connection_id for update;
  if _connection.id is null or _connection.organization_id<>_org or _connection.consumer_person_id is distinct from _actor then
    raise exception using errcode='42501',message='care_message_refused'; end if;
  _accessible:=_connection.state='verified' and clinical_private.production_care_message_consent(_connection_id)
    and exists(select 1 from clinical_core.patient_records where id=_connection.patient_record_id and organization_id=_org and status='active');
  if _action='receipt' and not _accessible then raise exception using errcode='42501',message='care_message_refused'; end if;
  insert into clinical_audit.care_message_access_events(organization_id,actor_person_id,action) values(_org,_actor,_action);
  perform pg_advisory_xact_lock(hashtextextended(_actor::text,0));
  select * into _receipt from clinical_core.care_message_receipts where sender_id=_actor and request_id=_request_id;
  if found then
    select connection_id into _actual_connection from clinical_core.care_message_thread_links where conversation_id=_receipt.conversation_id;
    if not _accessible or _actual_connection is distinct from _connection_id then
      if _action='settle' then return jsonb_build_object('action',_action,'requestId',_request_id,'connectionId',_connection_id,'status','withheld'); end if;
      raise exception using errcode='42501',message='care_message_refused';
    end if;
    return jsonb_build_object('action',_action,'requestId',_request_id,'connectionId',_connection_id,'status','committed',
      'threadId',_receipt.conversation_id,'messageId',_receipt.message_id);
  end if;
  if _action='settle' then
    insert into clinical_core.care_message_cancellations(sender_id,request_id,connection_id) values(_actor,_request_id,_connection_id)
      on conflict(sender_id,request_id) do nothing;
    return jsonb_build_object('action',_action,'requestId',_request_id,'connectionId',_connection_id,'status','cancelled');
  end if;
  return jsonb_build_object('action',_action,'requestId',_request_id,'connectionId',_connection_id,
    'status',case when exists(select 1 from clinical_core.care_message_cancellations where sender_id=_actor and request_id=_request_id)
      then 'cancelled' else 'unresolved' end);
end $$;
revoke all on function clinical_core.production_care_message_request(jsonb),clinical_core.production_care_message_resolve(jsonb) from public;
grant execute on function clinical_core.production_care_message_request(jsonb),clinical_core.production_care_message_resolve(jsonb) to clinical_core_api;

-- Privacy access survives withdrawal and replacement of the clinic link. The
-- immutable owner on the thread prevents a reassigned connection leaking old
-- records to a new owner. Pages are live reads, NOT an atomic account snapshot.
create function clinical_core.production_care_message_export(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _section text; _before bigint:=9223372036854775807;
  _items jsonb:='[]'::jsonb; _row jsonb; _last text; _bytes integer:=2; _count integer:=0; _more boolean:=false;
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management'
    or _request is null or jsonb_typeof(_request) is distinct from 'object' or octet_length(_request::text)>1024
    or _request-array['action','section','before']<>'{}'::jsonb or _request->>'action' is distinct from 'export'
    or _request->>'section' is null or _request->>'section' not in ('threads','messages','settlements') then
    raise exception using errcode='22023',message='care_message_invalid'; end if;
  _section:=_request->>'section';
  if _request ? 'before' then
    if jsonb_typeof(_request->'before') is distinct from 'string' or _request->>'before' !~ '^[1-9][0-9]{0,17}$' then
      raise exception using errcode='22023',message='care_message_invalid'; end if;
    _before:=(_request->>'before')::bigint;
  end if;
  for _row in
    select item from (
      select l.sequence as seq,jsonb_build_object('sequence',l.sequence::text,'threadId',t.id,'connectionId',l.connection_id,
        'patientRecordId',t.patient_record_id,'subject',t.subject,'createdAt',t.created_at,'updatedAt',t.updated_at) item
      from clinical_core.care_message_thread_links l join clinical_core.conversations t on t.id=l.conversation_id
      where _section='threads' and l.consumer_person_id=_actor and l.sequence<_before
      union all
      select r.sequence,jsonb_build_object('sequence',r.sequence::text,'threadId',r.conversation_id,'messageId',r.message_id,
        'body',m.body,'sender',r.sender_pool,'createdAt',m.created_at)
      from clinical_core.care_message_receipts r join clinical_core.care_message_thread_links l on l.conversation_id=r.conversation_id
      join clinical_core.messages m on m.id=r.message_id
      where _section='messages' and l.consumer_person_id=_actor and r.sequence<_before
      union all
      select c.sequence,jsonb_build_object('sequence',c.sequence::text,'requestId',c.request_id,'connectionId',c.connection_id,
        'status','cancelled','settledAt',c.settled_at)
      from clinical_core.care_message_cancellations c where _section='settlements' and c.sender_id=_actor and c.sequence<_before
    ) rows order by seq desc limit 31
  loop
    if _count>=30 or _bytes+octet_length(_row::text)+1>131072 then _more:=true; exit; end if;
    _items:=_items||jsonb_build_array(_row); _bytes:=_bytes+octet_length(_row::text)+1;
    _last:=_row->>'sequence'; _count:=_count+1;
  end loop;
  if _more and _count=0 then raise exception using errcode='22023',message='care_message_invalid'; end if;
  insert into clinical_audit.care_message_access_events(organization_id,actor_person_id,action)
    values(clinical_private.organization_id(),_actor,'export');
  return jsonb_build_object('contract','care-message-export/1','section',_section,'records',_items,
    'nextBefore',case when _more then _last else null end,'coverage','retained_in_app_messages_live_pages');
end $$;
revoke all on function clinical_core.production_care_message_export(jsonb) from public;
grant execute on function clinical_core.production_care_message_export(jsonb) to clinical_core_api;
