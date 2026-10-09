-- Consumer-owned settlement of an unresolved send. Synthetic-only; no production activation and no message content.
--
-- The gap this closes: a send whose response was lost leaves the device holding
-- metadata only (request identity and a digest, never the body), so the owner
-- cannot reconstruct the text and cannot honestly be told to "retry". Clearing
-- the journal and issuing a new request id is not a fix: the original request
-- may still be admitted afterwards and would deliver a message the owner
-- believes they cancelled.
--
-- Settlement is therefore a server decision, not a client one. It is keyed by
-- (sender, request id) and serialised against send by the SAME per-sender
-- advisory lock `care_message_request` takes, so exactly one of the two orders
-- can happen:
--   send first  -> settle observes the committed row and reports delivery.
--   settle first -> the tombstone exists and the late send is refused.
-- The refusal is a trigger on care_messages rather than a rewrite of
-- `care_message_request`, so it holds for every insert path, present or future.
create table clinical_core.care_message_settlements(
 id uuid primary key default gen_random_uuid(),
 sender_id uuid not null references clinical_core.persons(id),
 request_id uuid not null,
 connection_id uuid not null references clinical_core.patient_connections(id),
 organization_id uuid not null references clinical_core.organizations(id),
 settled_at timestamptz not null default clock_timestamp(),
 unique(sender_id,request_id)
);
create index care_message_settlements_connection on clinical_core.care_message_settlements(connection_id,settled_at);
alter table clinical_core.care_message_settlements enable row level security;
revoke all on clinical_core.care_message_settlements from public,clinical_core_api;
create trigger care_message_settlements_immutable before update or delete on clinical_core.care_message_settlements
 for each row execute function clinical_private.block_update_delete();

alter table clinical_core.care_message_audit drop constraint care_message_audit_action_check;
alter table clinical_core.care_message_audit add constraint care_message_audit_action_check
 check(action in('list','read','send','receipt','settle'));

-- A tombstone outranks a late or replayed admission, whichever code path attempts it.
create function clinical_private.refuse_settled_care_message() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from clinical_core.care_message_settlements s
  where s.sender_id=new.sender_id and s.request_id=new.request_id) then
  raise exception using errcode='40001',message='care_message_settled'; end if;
 return new;
end $$;
revoke all on function clinical_private.refuse_settled_care_message() from public;
create trigger care_messages_refuse_settled before insert on clinical_core.care_messages
 for each row execute function clinical_private.refuse_settled_care_message();

create function clinical_core.care_message_settle(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 _actor uuid:=clinical_private.actor_person_id(); _org uuid:=clinical_private.organization_id();
 _connection clinical_core.patient_connections%rowtype; _message_id uuid; _thread_id uuid;
 _request_id uuid; _connection_id uuid; _message_connection uuid; _accessible boolean;
begin
 perform clinical_private.assert_synthetic_context(_org,'clinical_data');
 if _actor is null or _org is null or clinical_private.claim('identity_pool') is distinct from 'consumer'
 or not exists(select 1 from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
  where i.person_id=_actor and i.identity_pool='consumer' and i.identity_subject=clinical_private.claim('identity_subject')
  and i.status='active' and p.status='active' and i.synthetic_attested)
 or not exists(select 1 from clinical_core.organizations where id=_org and status='active') then
  raise exception using errcode='42501',message='care_message_refused'; end if;
 if _request is null or jsonb_typeof(_request)<>'object' or octet_length(_request::text)>1024
 or _request->>'action' is distinct from 'settle' or _request-array['action','requestId','connectionId']<>'{}'::jsonb
 or jsonb_typeof(_request->'requestId') is distinct from 'string'
 or jsonb_typeof(_request->'connectionId') is distinct from 'string'
 or (_request->>'requestId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 or (_request->>'connectionId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
  raise exception using errcode='22023',message='care_message_invalid'; end if;
 _request_id:=(_request->>'requestId')::uuid; _connection_id:=(_request->>'connectionId')::uuid;
 -- Ownership of the link is what authorises settling it. Current verification is a
 -- separate question, answered below, because a revoked clinic must not become a
 -- reason the owner can never resolve their own stuck send.
 select * into _connection from clinical_core.patient_connections where id=_connection_id for update;
 if _connection.id is null or _connection.organization_id<>_org
 or _connection.consumer_person_id is distinct from _actor then
  raise exception using errcode='42501',message='care_message_refused'; end if;
 _accessible:=_connection.state='verified' and exists(select 1 from clinical_core.patient_records
  where id=_connection.patient_record_id and organization_id=_org and status='active');
 -- The single serialisation point shared with care_message_request's send branch.
 perform pg_advisory_xact_lock(hashtextextended(_actor::text,0));
 -- Deliberately NOT narrowed to the named connection. A request id is unique per
 -- sender, so narrowing here would report "cancelled" for a send that committed on
 -- a link the owner named wrongly -- the one false cancellation this must never emit.
 -- The named connection decides disclosure below, never existence.
 select m.id,m.thread_id,t.connection_id into _message_id,_thread_id,_message_connection
 from clinical_core.care_messages m join clinical_core.care_message_threads t on t.id=m.thread_id
 where m.sender_id=_actor and m.sender_pool='consumer' and m.request_id=_request_id;
 insert into clinical_core.care_message_audit(actor_id,organization_id,action,thread_id)
 values(_actor,_org,'settle',case when _accessible and _message_connection=_connection_id then _thread_id end);
 if _message_id is not null then
  -- Delivery happened. Reporting it is not cancellation, and a thread the owner can
  -- no longer read must not be named by a settlement request.
  if not _accessible or _message_connection is distinct from _connection_id then
   return jsonb_build_object('action','settle','requestId',_request_id,'connectionId',_connection_id,'status','withheld'); end if;
  return jsonb_build_object('action','settle','requestId',_request_id,'connectionId',_connection_id,
   'status','committed','threadId',_thread_id,'messageId',_message_id);
 end if;
 insert into clinical_core.care_message_settlements(sender_id,request_id,connection_id,organization_id)
 values(_actor,_request_id,_connection_id,_org) on conflict(sender_id,request_id) do nothing;
 return jsonb_build_object('action','settle','requestId',_request_id,'connectionId',_connection_id,'status','cancelled');
end $$;
revoke all on function clinical_core.care_message_settle(jsonb) from public;
grant execute on function clinical_core.care_message_settle(jsonb) to clinical_core_api;

-- Receipt gains the settled outcome so a second device converges on the decision
-- instead of reporting an unresolved send that can no longer commit.
create or replace function clinical_core.care_message_receipt(_request jsonb) returns jsonb
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
 if _message_id is not null then
  return jsonb_build_object('action','receipt','requestId',_request_id,'connectionId',_connection_id,
   'status','committed','threadId',_thread_id,'messageId',_message_id); end if;
 if exists(select 1 from clinical_core.care_message_settlements
  where sender_id=_actor and request_id=_request_id and connection_id=_connection_id) then
  return jsonb_build_object('action','receipt','requestId',_request_id,'connectionId',_connection_id,'status','cancelled'); end if;
 return jsonb_build_object('action','receipt','requestId',_request_id,'connectionId',_connection_id,'status','unresolved');
end $$;
