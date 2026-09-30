-- Owner export and erasure for the consult-request and pre-visit-form domains.
-- Synthetic-only. No real patient data, and nothing here is enabled for production.
--
-- The two domains added today shipped with no lifecycle. An owner asking for a copy of
-- their data would have been handed messages and programs and told that was everything,
-- while their intake answers, their signatures and the request that first reached the
-- clinic sat outside the export. That is the failure mode the messaging domains had before
-- migration 36, and it is worse here, because a signed document is exactly the thing a
-- person is most entitled to keep a copy of.
--
-- Three decisions, following the rules migration 36 already set rather than inventing new
-- ones.
--
-- A packet and its items are the clinic's record that it asked. On a domain erase they are
-- kept, for the same reason a message thread the clinic has written in is kept: erasing a
-- shared record would delete something belonging to someone who did not ask. The answer
-- reports what was kept and why.
--
-- A signature is retained by a domain erase and removed only by account closure. It is the
-- same shape as a settlement tombstone: the clinic's record of the basis on which care was
-- given, which a request to tidy up one domain should not quietly destroy. THIS IS A
-- RETENTION DECISION AND NOT A LEGAL OPINION — if a real obligation requires a signature to
-- outlive the account, that is the owner's decision with counsel, and this is the one place
-- to change it.
--
-- A consult request is erased only by account closure, and only when it was converted, so
-- the owner's own connection reaches it. A request that was never converted is not reachable
-- from any account, because nobody proved it was theirs; those are not covered here and the
-- handoff says so rather than implying they are.

alter table clinical_core.care_data_erasures
 add column responses_erased integer not null default 0 check(responses_erased>=0),
 add column packets_retained integer not null default 0 check(packets_retained>=0),
 add column packets_erased integer not null default 0 check(packets_erased>=0),
 add column signatures_retained integer not null default 0 check(signatures_retained>=0),
 add column signatures_erased integer not null default 0 check(signatures_erased>=0),
 add column consult_requests_erased integer not null default 0 check(consult_requests_erased>=0);
-- A domain erase never removes either; closure is the only thing that can.
alter table clinical_core.care_data_erasures
 add constraint care_data_erasures_signature_scope
  check(scope='account_closure' or signatures_erased=0),
 add constraint care_data_erasures_packet_scope
  check(scope='account_closure' or packets_erased=0),
 add constraint care_data_erasures_consult_scope
  check(scope='account_closure' or consult_requests_erased=0);

-- The content-free audit row outlives the request it describes.
--
-- Found by the closure test rather than by reading, in two steps. First the audit's foreign
-- key made an account closure fail outright, because the request could not go while a row
-- pointed at it; keeping the request to keep the audit would have defeated the closure, and
-- dropping the audit would have destroyed the record that a link received anything at all, so
-- the reference is released instead. Then releasing it failed too: `on delete set null` is an
-- update, and the audit table refuses every update.
--
-- So the refusal is narrowed rather than lifted, in the same shape as the erasure window
-- elsewhere in this family. One update is permitted — releasing a reference to a request that
-- has gone — and nothing else about the row may move. A delete stays refused outright.
alter table clinical_core.consult_request_audit
 drop constraint consult_request_audit_request_id_fkey,
 add constraint consult_request_audit_request_id_fkey
  foreign key (request_id) references clinical_core.consult_requests(id) on delete set null;

create or replace function clinical_private.consult_audit_guard() returns trigger
language plpgsql set search_path='' as $$
begin
 if tg_op='UPDATE'
 and old.request_id is not null and new.request_id is null
 and new.id=old.id and new.organization_id=old.organization_id
 and new.link_id is not distinct from old.link_id
 and new.actor_id is not distinct from old.actor_id
 and new.action=old.action and new.occurred_at=old.occurred_at then
  return new;
 end if;
 raise exception using errcode='55000',message='append_only_record';
end $$;
revoke all on function clinical_private.consult_audit_guard() from public;
drop trigger consult_request_audit_append_only on clinical_core.consult_request_audit;
create trigger consult_request_audit_append_only before update or delete
 on clinical_core.consult_request_audit for each row
 execute function clinical_private.consult_audit_guard();

/* The narrow delete window, widened to the new append-only tables and to nothing else.
   Updates stay refused unconditionally, and even inside the window a row only goes if it
   belongs to the owner the erasure is running for. */
create or replace function clinical_private.block_except_owner_erasure() returns trigger
language plpgsql set search_path='' as $$
declare _owner uuid:=clinical_private.care_erasure_owner(); _row_owner uuid;
begin
 if tg_op='DELETE' and _owner is not null then
  if tg_table_name='care_messages' then _row_owner:=old.sender_id;
  elsif tg_table_name='care_message_settlements' then _row_owner:=old.sender_id;
  elsif tg_table_name='intake_form_responses' then _row_owner:=old.submitted_by_person_id;
  elsif tg_table_name='document_signatures' then _row_owner:=old.signed_by_person_id;
  else
   select a.consumer_person_id into _row_owner from clinical_core.program_assignments a
   where a.id=old.assignment_id;
  end if;
  if _row_owner=_owner then return old; end if;
 end if;
 raise exception using errcode='55000',message='append_only_record';
end $$;

drop trigger intake_form_responses_append_only on clinical_core.intake_form_responses;
create trigger intake_form_responses_append_only before update or delete
 on clinical_core.intake_form_responses for each row
 execute function clinical_private.block_except_owner_erasure();
drop trigger document_signatures_append_only on clinical_core.document_signatures;
create trigger document_signatures_append_only before update or delete
 on clinical_core.document_signatures for each row
 execute function clinical_private.block_except_owner_erasure();

/* A consult request keeps its own protection, because what it said on arrival must stay
   unchanged whatever else happens. The one thing added is a delete inside the erasure
   window, for a request the owner's own connection reaches. */
create or replace function clinical_private.protect_consult_request() returns trigger
language plpgsql security invoker set search_path='' as $$
declare _owner uuid;
begin
 if tg_op='DELETE' then
  _owner:=clinical_private.care_erasure_owner();
  if _owner is not null and old.connection_id is not null
  and exists(select 1 from clinical_core.patient_connections c
   where c.id=old.connection_id and c.consumer_person_id=_owner) then
   return old;
  end if;
  raise exception using errcode='55000',message='append_only_record';
 end if;
 if new.id is distinct from old.id
 or new.organization_id is distinct from old.organization_id
 or new.link_id is distinct from old.link_id
 or new.reference_code is distinct from old.reference_code
 or new.contact_ciphertext is distinct from old.contact_ciphertext
 or new.contact_iv is distinct from old.contact_iv
 or new.contact_tag is distinct from old.contact_tag
 or new.contact_digest is distinct from old.contact_digest
 or new.visit_type is distinct from old.visit_type
 or new.reason_code is distinct from old.reason_code
 or new.preferred_windows is distinct from old.preferred_windows
 or new.received_at is distinct from old.received_at then
  raise exception using errcode='55000',message='consult_request_immutable';
 end if;
 return new;
end $$;

/* The owner's own records, now across six domains. Same contract, same page budget, same
   cursor discipline; four more sections. */
create or replace function clinical_core.care_data_export(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 _actor uuid:=clinical_private.actor_person_id(); _org uuid:=clinical_private.organization_id();
 _pool text:=clinical_private.claim('identity_pool'); _section text:=_request->>'section';
 _limit integer; _after text; _items jsonb; _next text;
begin
 perform clinical_private.assert_synthetic_context(_org,'consent_management');
 if _actor is null or _pool<>'consumer'
 or not exists(select 1 from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
  where i.person_id=_actor and i.identity_pool='consumer' and i.identity_subject=clinical_private.claim('identity_subject')
  and i.status='active' and p.status='active' and i.synthetic_attested) then
  raise exception using errcode='42501',message='care_data_forbidden'; end if;
 if _request is null or clinical_private.jsonb_kind(_request)<>'object'
 or _request-array['action','section','limit','after']<>'{}'::jsonb
 or (_request->>'action') is distinct from 'export'
 or _section is null or _section not in('threads','messages','settlements','assignments','completions',
  'authorizations','intake_packets','intake_responses','signatures','consult_requests') then
  raise exception using errcode='22023',message='care_data_invalid'; end if;
 _limit:=coalesce((_request->>'limit')::integer,100);
 if _limit<1 or _limit>100 then raise exception using errcode='22023',message='care_data_invalid'; end if;
 _after:=nullif(_request->>'after','');

 if _section='threads' then
  select coalesce(jsonb_agg(row order by row->>'cursor'),'[]'::jsonb) into _items from (
   select jsonb_build_object('cursor',lpad(t.sequence::text,19,'0'),'threadId',t.id,'subject',t.subject,
    'createdAt',t.created_at,'updatedAt',t.updated_at) as row
   from clinical_core.care_message_threads t
   where exists(select 1 from clinical_core.care_messages m where m.thread_id=t.id and m.sender_id=_actor)
   and (_after is null or lpad(t.sequence::text,19,'0')>_after)
   order by t.sequence limit _limit+1) page;
 elsif _section='messages' then
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
 elsif _section='authorizations' then
  select coalesce(jsonb_agg(row order by row->>'cursor'),'[]'::jsonb) into _items from (
   select jsonb_build_object('cursor',z.assignment_id::text||':'||z.phase_id||':'||z.kind,
    'enrollmentId',z.assignment_id,'phaseId',z.phase_id,'kind',z.kind,'authorizedAt',z.recorded_at) as row
   from clinical_core.program_phase_authorizations z
   join clinical_core.program_assignments a on a.id=z.assignment_id
   where a.consumer_person_id=_actor
   and (_after is null or z.assignment_id::text||':'||z.phase_id||':'||z.kind>_after)
   order by z.assignment_id,z.phase_id,z.kind limit _limit+1) page;
 elsif _section='intake_packets' then
  -- What was asked of them, whatever happened to the link since.
  select coalesce(jsonb_agg(row order by row->>'cursor'),'[]'::jsonb) into _items from (
   select jsonb_build_object('cursor',p.id::text,'packetId',p.id,'label',p.label,'status',p.status,
    'dueBefore',p.due_before,'assignedAt',p.created_at,'completedAt',p.completed_at,
    'forms',(select coalesce(jsonb_agg(jsonb_build_object('itemId',i.id,'position',i.position,
      'required',i.required,'formKey',v.form_key,'version',v.version,'title',v.title,'kind',v.kind,
      'contentSha256',v.content_sha256) order by i.position),'[]'::jsonb)
     from clinical_core.intake_packet_items i
     join clinical_core.intake_form_versions v on v.id=i.form_version_id
     where i.packet_id=p.id)) as row
   from clinical_core.intake_packets p
   join clinical_core.patient_connections c on c.id=p.connection_id
   where c.consumer_person_id=_actor and (_after is null or p.id::text>_after)
   order by p.id limit _limit+1) page;
 elsif _section='intake_responses' then
  -- Their own answers, in full, with the text they were answering identified by digest.
  select coalesce(jsonb_agg(row order by row->>'cursor'),'[]'::jsonb) into _items from (
   select jsonb_build_object('cursor',r.id::text,'responseId',r.id,'packetItemId',r.packet_item_id,
    'formKey',v.form_key,'version',v.version,'title',v.title,
    'formContentSha256',r.form_content_sha256,'answers',r.answers,'answersSha256',r.answers_sha256,
    'submittedAt',r.submitted_at) as row
   from clinical_core.intake_form_responses r
   join clinical_core.intake_form_versions v on v.id=r.form_version_id
   where r.submitted_by_person_id=_actor and (_after is null or r.id::text>_after)
   order by r.id limit _limit+1) page;
 elsif _section='signatures' then
  -- A copy of a signed document is the thing a person most needs to be able to keep, so
  -- the export carries the words themselves and not only a digest of them.
  select coalesce(jsonb_agg(row order by row->>'cursor'),'[]'::jsonb) into _items from (
   select jsonb_build_object('cursor',s.id::text,'signatureId',s.id,'packetItemId',s.packet_item_id,
    'formKey',v.form_key,'version',v.version,'title',v.title,
    'document',v.content,'formContentSha256',s.form_content_sha256,
    'agreementStatement',v.content->'agreement'->>'statement','agreementSha256',s.agreement_sha256,
    'signerName',s.signer_name,'signerAuthority',s.signer_authority,'signedAt',s.signed_at) as row
   from clinical_core.document_signatures s
   join clinical_core.intake_form_versions v on v.id=s.form_version_id
   where s.signed_by_person_id=_actor and (_after is null or s.id::text>_after)
   order by s.id limit _limit+1) page;
 else
  -- Reached through their own connection, which is the only thing that ties a request made
  -- before they had an account to the account they now have. The sealed contact envelope is
  -- deliberately not here: this database cannot open it, and a ciphertext in an export is
  -- not a copy of anything the owner can read.
  select coalesce(jsonb_agg(row order by row->>'cursor'),'[]'::jsonb) into _items from (
   select jsonb_build_object('cursor',q.id::text,'requestId',q.id,'reference',q.reference_code,
    'visitType',q.visit_type,'reasonCode',q.reason_code,'status',q.status,
    'preferredWindows',q.preferred_windows,'timeZone',q.time_zone,
    'receivedAt',q.received_at,'decidedAt',q.decided_at,'declineReason',q.decline_reason,
    'convertedAt',q.converted_at) as row
   from clinical_core.consult_requests q
   join clinical_core.patient_connections c on c.id=q.connection_id
   where c.consumer_person_id=_actor and (_after is null or q.id::text>_after)
   order by q.id limit _limit+1) page;
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
 _retained integer:=0; _assignments integer:=0; _responses integer:=0;
 _packets_kept integer:=0; _packets_gone integer:=0; _signatures_kept integer:=0;
 _signatures_gone integer:=0; _consults integer:=0; _row clinical_core.care_data_erasures%rowtype;
begin
 perform clinical_private.assert_synthetic_context(_org,'consent_management');
 if _actor is null or _pool<>'consumer'
 or not exists(select 1 from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
  where i.person_id=_actor and i.identity_pool='consumer' and i.identity_subject=clinical_private.claim('identity_subject')
  and i.status='active' and p.status='active' and i.synthetic_attested) then
  raise exception using errcode='42501',message='care_data_forbidden'; end if;
 if _request is null or clinical_private.jsonb_kind(_request)<>'object'
 or _request-array['action','scope']<>'{}'::jsonb
 or (_request->>'action') is distinct from 'erase'
 or _scope is null or _scope not in('domain','account_closure') then
  raise exception using errcode='22023',message='care_data_invalid'; end if;
 perform pg_advisory_xact_lock(hashtextextended(_actor::text,0));
 perform set_config('clinical_private.care_erasure',_actor::text,true);

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

 with candidates as (
  select t.id from clinical_core.care_message_threads t
  where not exists(select 1 from clinical_core.care_messages m where m.thread_id=t.id)
 ), removed as (
  delete from clinical_core.care_message_threads t using candidates c where t.id=c.id returning t.id
 ) select count(*) into _threads from removed;
 select count(*) into _kept from clinical_core.care_message_threads t
  where exists(select 1 from clinical_core.care_messages m where m.thread_id=t.id);

 -- Their answers are their own words, so they go on either scope.
 delete from clinical_core.intake_form_responses r where r.submitted_by_person_id=_actor;
 get diagnostics _responses=row_count;

 if _scope='account_closure' then
  delete from clinical_core.care_message_settlements s where s.sender_id=_actor;
  get diagnostics _settlements=row_count;
  _retained:=0;

  delete from clinical_core.document_signatures s where s.signed_by_person_id=_actor;
  get diagnostics _signatures_gone=row_count;
  _signatures_kept:=0;

  -- Items before packets, and both only once nothing points at them any more.
  delete from clinical_core.intake_packet_items i
   using clinical_core.intake_packets p, clinical_core.patient_connections c
   where i.packet_id=p.id and c.id=p.connection_id and c.consumer_person_id=_actor;
  delete from clinical_core.intake_packets p
   using clinical_core.patient_connections c
   where c.id=p.connection_id and c.consumer_person_id=_actor;
  get diagnostics _packets_gone=row_count;
  _packets_kept:=0;

  delete from clinical_core.consult_requests q
   using clinical_core.patient_connections c
   where c.id=q.connection_id and c.consumer_person_id=_actor;
  get diagnostics _consults=row_count;
 else
  select count(*) into _retained from clinical_core.care_message_settlements s where s.sender_id=_actor;
  select count(*) into _signatures_kept from clinical_core.document_signatures s
   where s.signed_by_person_id=_actor;
  -- The packet is the clinic's record that it asked, so a domain erase keeps it, exactly as
  -- it keeps a thread the clinic has written in.
  select count(*) into _packets_kept from clinical_core.intake_packets p
   join clinical_core.patient_connections c on c.id=p.connection_id
   where c.consumer_person_id=_actor;
 end if;

 insert into clinical_core.care_data_erasures(owner_id,scope,messages_erased,threads_erased,threads_retained,
  settlements_erased,settlements_retained,assignments_erased,late_admission_refusable,
  responses_erased,packets_retained,packets_erased,signatures_retained,signatures_erased,
  consult_requests_erased)
 values(_actor,_scope,_messages,_threads,_kept,_settlements,_retained,_assignments,_scope='domain',
  _responses,_packets_kept,_packets_gone,_signatures_kept,_signatures_gone,_consults)
 returning * into _row;

 perform set_config('clinical_private.care_erasure','',true);

 return jsonb_build_object('action','erase','scope',_scope,'erasureId',_row.id,
  'messagesErased',_messages,'threadsErased',_threads,'threadsRetained',_kept,
  'assignmentsErased',_assignments,
  'settlementsErased',_settlements,'settlementsRetained',_retained,
  'responsesErased',_responses,
  'packetsRetained',_packets_kept,'packetsErased',_packets_gone,
  'signaturesRetained',_signatures_kept,'signaturesErased',_signatures_gone,
  'consultRequestsErased',_consults,
  'lateAdmissionRefusable',_scope='domain',
  'retainedReason',case when _scope='domain' and _retained>0
   then 'cancellation_refusal_must_outlive_late_admission' else null end,
  'threadsRetainedReason',case when _kept>0 then 'thread_holds_another_participant_record' else null end,
  'packetsRetainedReason',case when _packets_kept>0
   then 'packet_is_the_clinic_record_of_what_was_asked' else null end,
  'signaturesRetainedReason',case when _signatures_kept>0
   then 'signature_is_the_recorded_basis_for_care_already_given' else null end);
end $$;
revoke all on function clinical_core.care_data_erase(jsonb) from public;
grant execute on function clinical_core.care_data_erase(jsonb) to clinical_core_api;

create or replace function clinical_core.care_data_erasure_history(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.actor_person_id(); _pool text:=clinical_private.claim('identity_pool');
 _org uuid:=clinical_private.organization_id(); _items jsonb;
begin
 perform clinical_private.assert_synthetic_context(_org,'consent_management');
 if _actor is null or _pool<>'consumer' then
  raise exception using errcode='42501',message='care_data_forbidden'; end if;
 if _request is null or clinical_private.jsonb_kind(_request)<>'object'
 or _request-array['action']<>'{}'::jsonb
 or (_request->>'action') is distinct from 'erasure_history' then
  raise exception using errcode='22023',message='care_data_invalid'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('erasureId',e.id,'scope',e.scope,
   'messagesErased',e.messages_erased,'threadsErased',e.threads_erased,'threadsRetained',e.threads_retained,
   'settlementsErased',e.settlements_erased,'settlementsRetained',e.settlements_retained,
   'assignmentsErased',e.assignments_erased,'responsesErased',e.responses_erased,
   'packetsRetained',e.packets_retained,'packetsErased',e.packets_erased,
   'signaturesRetained',e.signatures_retained,'signaturesErased',e.signatures_erased,
   'consultRequestsErased',e.consult_requests_erased,
   'lateAdmissionRefusable',e.late_admission_refusable,
   'occurredAt',e.occurred_at) order by e.occurred_at desc),'[]'::jsonb) into _items
 from (select * from clinical_core.care_data_erasures where owner_id=_actor order by occurred_at desc limit 50) e;
 return jsonb_build_object('action','erasure_history','erasures',_items);
end $$;
revoke all on function clinical_core.care_data_erasure_history(jsonb) from public;
grant execute on function clinical_core.care_data_erasure_history(jsonb) to clinical_core_api;
