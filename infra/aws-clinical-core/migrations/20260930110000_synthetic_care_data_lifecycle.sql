-- Owner export, erasure and retention for the messaging and program domains.
-- Synthetic-only; no production activation.
--
-- These two domains were built with no lifecycle, and the deferral that recorded
-- that named four obligations. This is those four, answered in the target that
-- actually holds the data rather than promised for one that does not.
--
-- Three of the answers are decisions rather than mechanics, so they are stated
-- here where the code that enforces them can be read beside them.
--
-- A settled tombstone is not erased by a domain erase. Its whole purpose is to
-- refuse the late admission of a request the owner cancelled, and a refusal that
-- expires is a refusal with a date on which cancellation silently stops working.
-- Rather than invent a retention period nobody could justify, the tombstone lives
-- exactly as long as the account does: a domain erase reports it as retained with
-- its reason, and only account closure removes it. Account closure also records
-- that late admission is no longer refusable afterwards, because that is true and
-- whoever closes the account should be told.
--
-- A thread is shared, so it is not the owner's alone to erase. The owner's own
-- messages are erased; the thread survives while the clinic side still has
-- messages in it, and the answer says which threads were kept and why. Erasing a
-- shared thread would delete a record belonging to someone who did not ask.
--
-- A withdrawn clinic link does not hide the owner's own words from their own
-- export, and does not stop their erasure. Reads through a withdrawn link are
-- refused because reading is reaching into the clinic's side; an export of what
-- the owner wrote is not. Nothing in these functions consults link state, and the
-- tests assert that a revoked link changes neither answer.
create table clinical_core.care_data_erasures(
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references clinical_core.persons(id),
 scope text not null check(scope in('domain','account_closure')),
 -- Counts only. What was erased is not itself recorded, or the erasure record
 -- would become a copy of the thing erased.
 messages_erased integer not null check(messages_erased>=0),
 threads_erased integer not null check(threads_erased>=0),
 threads_retained integer not null check(threads_retained>=0),
 settlements_erased integer not null check(settlements_erased>=0),
 settlements_retained integer not null check(settlements_retained>=0),
 assignments_erased integer not null check(assignments_erased>=0),
 late_admission_refusable boolean not null,
 occurred_at timestamptz not null default clock_timestamp(),
 -- A domain erase always leaves the refusal standing; closure always ends it.
 check((scope='domain') = late_admission_refusable),
 check(scope='account_closure' or settlements_erased=0)
);
alter table clinical_core.care_data_erasures enable row level security;
revoke all on clinical_core.care_data_erasures from public,clinical_core_api;
create index care_data_erasures_owner_idx on clinical_core.care_data_erasures(owner_id,occurred_at desc);

create or replace function clinical_private.care_data_immutable() returns trigger
language plpgsql as $$
begin raise exception using errcode='22023',message='care_data_erasure_immutable'; end $$;
revoke all on function clinical_private.care_data_immutable() from public;
create trigger care_data_erasures_append_only before update or delete
 on clinical_core.care_data_erasures for each row execute function clinical_private.care_data_immutable();

-- Erasure has to be able to delete rows that are otherwise append-only, and the
-- blanket refusal on those tables cannot simply be lifted: a message is a record of
-- what happened and must not be editable or removable by an ordinary statement.
--
-- So the refusal is narrowed rather than weakened. A delete is permitted only while a
-- reviewed erasure is running in the same transaction, and the flag that says so
-- carries the owner it is running for, so even inside that window only that owner's
-- rows can go. Updates stay refused unconditionally. The API role holds no table
-- privilege on any of these tables in the first place, so this is the second lock
-- rather than the only one.
create or replace function clinical_private.care_erasure_owner() returns uuid
language plpgsql stable set search_path='' as $$
declare _value text:=coalesce(current_setting('clinical_private.care_erasure',true),'');
begin
 if _value='' then return null; end if;
 return _value::uuid;
exception when others then return null;
end $$;
revoke all on function clinical_private.care_erasure_owner() from public;

create or replace function clinical_private.block_except_owner_erasure() returns trigger
language plpgsql set search_path='' as $$
declare _owner uuid:=clinical_private.care_erasure_owner(); _row_owner uuid;
begin
 if tg_op='DELETE' and _owner is not null then
  if tg_table_name='care_messages' then _row_owner:=old.sender_id;
  elsif tg_table_name='care_message_settlements' then _row_owner:=old.sender_id;
  else
   select a.consumer_person_id into _row_owner from clinical_core.program_assignments a
   where a.id=old.assignment_id;
  end if;
  if _row_owner=_owner then return old; end if;
 end if;
 raise exception using errcode='55000',message='append_only_record';
end $$;
revoke all on function clinical_private.block_except_owner_erasure() from public;

drop trigger care_messages_immutable on clinical_core.care_messages;
create trigger care_messages_immutable before update or delete on clinical_core.care_messages
 for each row execute function clinical_private.block_except_owner_erasure();
drop trigger care_message_settlements_immutable on clinical_core.care_message_settlements;
create trigger care_message_settlements_immutable before update or delete on clinical_core.care_message_settlements
 for each row execute function clinical_private.block_except_owner_erasure();
drop trigger program_assignment_completions_immutable on clinical_core.program_assignment_completions;
create trigger program_assignment_completions_immutable before update or delete on clinical_core.program_assignment_completions
 for each row execute function clinical_private.block_except_owner_erasure();
drop trigger program_phase_authorizations_immutable on clinical_core.program_phase_authorizations;
create trigger program_phase_authorizations_immutable before update or delete on clinical_core.program_phase_authorizations
 for each row execute function clinical_private.block_except_owner_erasure();

-- The owner's own records across both domains, paged. One contract, one page
-- budget, and a cursor that is total across sections so a caller cannot skip one.
create or replace function clinical_core.care_data_export(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 _actor uuid:=clinical_private.actor_person_id(); _org uuid:=clinical_private.organization_id();
 _pool text:=clinical_private.claim('identity_pool'); _section text:=_request->>'section';
 _limit integer; _after text; _items jsonb; _next text;
begin
 perform clinical_private.assert_synthetic_context(_org,'consent_management');
 -- The owner only. A workforce caller has its own reads and is not an owner here.
 if _actor is null or _pool<>'consumer'
 or not exists(select 1 from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
  where i.person_id=_actor and i.identity_pool='consumer' and i.identity_subject=clinical_private.claim('identity_subject')
  and i.status='active' and p.status='active' and i.synthetic_attested) then
  raise exception using errcode='42501',message='care_data_forbidden'; end if;
 if _request is null or jsonb_typeof(_request)<>'object'
 or _request-array['action','section','limit','after']<>'{}'::jsonb
 or (_request->>'action') is distinct from 'export'
 or _section is null or _section not in('threads','messages','settlements','assignments','completions','authorizations') then
  raise exception using errcode='22023',message='care_data_invalid'; end if;
 _limit:=coalesce((_request->>'limit')::integer,100);
 if _limit<1 or _limit>100 then raise exception using errcode='22023',message='care_data_invalid'; end if;
 _after:=nullif(_request->>'after','');

 if _section='threads' then
  -- A thread the owner has written in. Link state is deliberately not consulted:
  -- these are threads they took part in, whatever happened to the link since.
  select coalesce(jsonb_agg(row order by row->>'cursor'),'[]'::jsonb) into _items from (
   select jsonb_build_object('cursor',lpad(t.sequence::text,19,'0'),'threadId',t.id,'subject',t.subject,
    'createdAt',t.created_at,'updatedAt',t.updated_at) as row
   from clinical_core.care_message_threads t
   where exists(select 1 from clinical_core.care_messages m where m.thread_id=t.id and m.sender_id=_actor)
   and (_after is null or lpad(t.sequence::text,19,'0')>_after)
   order by t.sequence limit _limit+1) page;
 elsif _section='messages' then
  -- Bodies are the owner's own words, so they are in their export in full.
  select coalesce(jsonb_agg(row order by row->>'cursor'),'[]'::jsonb) into _items from (
   select jsonb_build_object('cursor',lpad(m.sequence::text,19,'0'),'messageId',m.id,'threadId',m.thread_id,
    'requestId',m.request_id,'body',m.body,'createdAt',m.created_at) as row
   from clinical_core.care_messages m
   where m.sender_id=_actor and m.sender_pool='consumer'
   and (_after is null or lpad(m.sequence::text,19,'0')>_after)
   order by m.sequence limit _limit+1) page;
 elsif _section='settlements' then
  select coalesce(jsonb_agg(row order by row->>'cursor'),'[]'::jsonb) into _items from (
   select jsonb_build_object('cursor',s.request_id::text,'requestId',s.request_id,'settledAt',s.settled_at) as row
   from clinical_core.care_message_settlements s
   where s.sender_id=_actor and (_after is null or s.request_id::text>_after)
   order by s.request_id limit _limit+1) page;
 elsif _section='assignments' then
  select coalesce(jsonb_agg(row order by row->>'cursor'),'[]'::jsonb) into _items from (
   select jsonb_build_object('cursor',a.id::text,'enrollmentId',a.id,'title',a.title,'state',a.state,
    'programVersionId',a.program_version_id,'sourceDigest',a.source_digest,'phaseIndex',a.phase_index,
    'finished',a.finished,'assignedAt',a.created_at,'phases',a.content) as row
   from clinical_core.program_assignments a
   where a.consumer_person_id=_actor and (_after is null or a.id::text>_after)
   order by a.id limit _limit+1) page;
 elsif _section='completions' then
  select coalesce(jsonb_agg(row order by row->>'cursor'),'[]'::jsonb) into _items from (
   select jsonb_build_object('cursor',c.assignment_id::text||':'||c.item_id,'enrollmentId',c.assignment_id,
    'itemId',c.item_id,'completedAt',c.completed_at) as row
   from clinical_core.program_assignment_completions c
   join clinical_core.program_assignments a on a.id=c.assignment_id
   where a.consumer_person_id=_actor
   and (_after is null or c.assignment_id::text||':'||c.item_id>_after)
   order by c.assignment_id,c.item_id limit _limit+1) page;
 else
  select coalesce(jsonb_agg(row order by row->>'cursor'),'[]'::jsonb) into _items from (
   select jsonb_build_object('cursor',z.assignment_id::text||':'||z.phase_id||':'||z.kind,
    'enrollmentId',z.assignment_id,'phaseId',z.phase_id,'kind',z.kind,'authorizedAt',z.recorded_at) as row
   from clinical_core.program_phase_authorizations z
   join clinical_core.program_assignments a on a.id=z.assignment_id
   where a.consumer_person_id=_actor
   and (_after is null or z.assignment_id::text||':'||z.phase_id||':'||z.kind>_after)
   order by z.assignment_id,z.phase_id,z.kind limit _limit+1) page;
 end if;

 if jsonb_array_length(_items)>_limit then
  _next:=(_items->(_limit-1))->>'cursor';
  _items:=(select coalesce(jsonb_agg(value),'[]'::jsonb) from jsonb_array_elements(_items) with ordinality
   where ordinality<=_limit);
 else _next:=null; end if;
 return jsonb_build_object('action','export','section',_section,
  'items',(select coalesce(jsonb_agg(value-'cursor'),'[]'::jsonb) from jsonb_array_elements(_items)),
  'next',_next);
end $$;
revoke all on function clinical_core.care_data_export(jsonb) from public;
grant execute on function clinical_core.care_data_export(jsonb) to clinical_core_api;

create or replace function clinical_core.care_data_erase(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 _actor uuid:=clinical_private.actor_person_id(); _org uuid:=clinical_private.organization_id();
 _pool text:=clinical_private.claim('identity_pool'); _scope text:=_request->>'scope';
 _messages integer:=0; _threads integer:=0; _kept integer:=0; _settlements integer:=0;
 _retained integer:=0; _assignments integer:=0; _row clinical_core.care_data_erasures%rowtype;
begin
 perform clinical_private.assert_synthetic_context(_org,'consent_management');
 if _actor is null or _pool<>'consumer'
 or not exists(select 1 from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
  where i.person_id=_actor and i.identity_pool='consumer' and i.identity_subject=clinical_private.claim('identity_subject')
  and i.status='active' and p.status='active' and i.synthetic_attested) then
  raise exception using errcode='42501',message='care_data_forbidden'; end if;
 if _request is null or jsonb_typeof(_request)<>'object'
 or _request-array['action','scope']<>'{}'::jsonb
 or (_request->>'action') is distinct from 'erase'
 or _scope is null or _scope not in('domain','account_closure') then
  raise exception using errcode='22023',message='care_data_invalid'; end if;
 -- One owner at a time, so a concurrent erase cannot half-run beside this one.
 perform pg_advisory_xact_lock(hashtextextended(_actor::text,0));
 -- Opens the narrow delete window, for this owner and this transaction only.
 perform set_config('clinical_private.care_erasure',_actor::text,true);

 -- Programs first: completions and authorisations belong to an assignment.
 delete from clinical_core.program_phase_authorizations z
  using clinical_core.program_assignments a
  where z.assignment_id=a.id and a.consumer_person_id=_actor;
 delete from clinical_core.program_assignment_completions c
  using clinical_core.program_assignments a
  where c.assignment_id=a.id and a.consumer_person_id=_actor;
 delete from clinical_core.program_assignments a where a.consumer_person_id=_actor;
 get diagnostics _assignments=row_count;

 delete from clinical_core.care_messages m where m.sender_id=_actor and m.sender_pool='consumer';
 get diagnostics _messages=row_count;

 -- A thread with nobody's messages left in it is nobody's record, so it goes. One
 -- that still holds the clinic's messages is the clinic's record and is kept.
 with candidates as (
  select t.id from clinical_core.care_message_threads t
  where not exists(select 1 from clinical_core.care_messages m where m.thread_id=t.id)
 ), removed as (
  delete from clinical_core.care_message_threads t using candidates c where t.id=c.id returning t.id
 ) select count(*) into _threads from removed;
 select count(*) into _kept from clinical_core.care_message_threads t
  where exists(select 1 from clinical_core.care_messages m where m.thread_id=t.id);

 if _scope='account_closure' then
  -- The refusal ends with the account, and the record says so.
  delete from clinical_core.care_message_settlements s where s.sender_id=_actor;
  get diagnostics _settlements=row_count;
  _retained:=0;
 else
  select count(*) into _retained from clinical_core.care_message_settlements s where s.sender_id=_actor;
 end if;

 insert into clinical_core.care_data_erasures(owner_id,scope,messages_erased,threads_erased,threads_retained,
  settlements_erased,settlements_retained,assignments_erased,late_admission_refusable)
 values(_actor,_scope,_messages,_threads,_kept,_settlements,_retained,_assignments,_scope='domain')
 returning * into _row;

 -- Closed again immediately: nothing after this point in the transaction may delete.
 perform set_config('clinical_private.care_erasure','',true);

 return jsonb_build_object('action','erase','scope',_scope,'erasureId',_row.id,
  'messagesErased',_messages,'threadsErased',_threads,'threadsRetained',_kept,
  'assignmentsErased',_assignments,
  'settlementsErased',_settlements,'settlementsRetained',_retained,
  'lateAdmissionRefusable',_scope='domain',
  'retainedReason',case when _scope='domain' and _retained>0
   then 'cancellation_refusal_must_outlive_late_admission' else null end,
  'threadsRetainedReason',case when _kept>0 then 'thread_holds_another_participant_record' else null end);
end $$;
revoke all on function clinical_core.care_data_erase(jsonb) from public;
grant execute on function clinical_core.care_data_erase(jsonb) to clinical_core_api;

-- What an operator may read about an owner's erasures: the counts and the decision,
-- never the content. Audit tables for both domains are retained as service
-- operations under the existing class vocabulary; they are content-free already.
create or replace function clinical_core.care_data_erasure_history(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.actor_person_id(); _pool text:=clinical_private.claim('identity_pool');
 _org uuid:=clinical_private.organization_id(); _items jsonb;
begin
 perform clinical_private.assert_synthetic_context(_org,'consent_management');
 if _actor is null or _pool<>'consumer' then
  raise exception using errcode='42501',message='care_data_forbidden'; end if;
 if _request is null or jsonb_typeof(_request)<>'object' or _request-array['action']<>'{}'::jsonb
 or (_request->>'action') is distinct from 'erasure_history' then
  raise exception using errcode='22023',message='care_data_invalid'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('erasureId',e.id,'scope',e.scope,
   'messagesErased',e.messages_erased,'threadsErased',e.threads_erased,'threadsRetained',e.threads_retained,
   'settlementsErased',e.settlements_erased,'settlementsRetained',e.settlements_retained,
   'assignmentsErased',e.assignments_erased,'lateAdmissionRefusable',e.late_admission_refusable,
   'occurredAt',e.occurred_at) order by e.occurred_at desc),'[]'::jsonb) into _items
 from (select * from clinical_core.care_data_erasures where owner_id=_actor order by occurred_at desc limit 50) e;
 return jsonb_build_object('action','erasure_history','erasures',_items);
end $$;
revoke all on function clinical_core.care_data_erasure_history(jsonb) from public;
grant execute on function clinical_core.care_data_erasure_history(jsonb) to clinical_core_api;
