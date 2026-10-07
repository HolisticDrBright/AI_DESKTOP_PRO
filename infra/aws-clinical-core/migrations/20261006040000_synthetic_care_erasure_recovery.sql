-- Synthetic-only correlated erasure. Not a production deletion authority.
-- Original erase and receipt remain one transaction; a cancelled UUID never admits late.
create or replace function clinical_core.care_data_erase(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 _actor uuid:=clinical_private.actor_person_id(); _org uuid:=clinical_private.organization_id();
 _pool text:=clinical_private.claim('identity_pool'); _scope text:=_request->>'scope';
 _messages integer:=0; _threads integer:=0; _kept integer:=0; _settlements integer:=0;
 _retained integer:=0; _assignments integer:=0; _responses integer:=0;
 _packets_kept integer:=0; _packets_gone integer:=0; _signatures_kept integer:=0;
 _signatures_gone integer:=0; _consults integer:=0; _statements integer:=0;
 _disputes_kept integer:=0; _disputes_gone integer:=0; _notices_gone integer:=0;
 _row clinical_core.care_data_erasures%rowtype;
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

 -- Before the assignments: a notice references the assignment it is about.
 delete from clinical_core.content_revision_notices n
  using clinical_core.patient_connections c
  where c.id=n.connection_id and c.consumer_person_id=_actor;
 get diagnostics _notices_gone=row_count;

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
  where exists(select 1 from clinical_core.patient_connections pc
    where pc.id=t.connection_id and pc.consumer_person_id=_actor)
  and not exists(select 1 from clinical_core.care_messages m where m.thread_id=t.id)
 ), removed as (
  delete from clinical_core.care_message_threads t using candidates c where t.id=c.id returning t.id
 ) select count(*) into _threads from removed;
 select count(*) into _kept from clinical_core.care_message_threads t
  where exists(select 1 from clinical_core.patient_connections pc
   where pc.id=t.connection_id and pc.consumer_person_id=_actor)
  and exists(select 1 from clinical_core.care_messages m where m.thread_id=t.id);

 -- Their answers are their own words, so they go on either scope.
 delete from clinical_core.intake_form_responses r where r.submitted_by_person_id=_actor;
 get diagnostics _responses=row_count;

 -- What they said in a dispute is theirs. The dispute itself is not: it records that an item
 -- was contested and what the clinician answered, which is the clinic's record of a decision.
 delete from clinical_core.clinical_dispute_statements s where s.stated_by_person_id=_actor;
 get diagnostics _statements=row_count;

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

  delete from clinical_core.clinical_disputes d
   using clinical_core.patient_connections c
   where c.id=d.connection_id and c.consumer_person_id=_actor;
  get diagnostics _disputes_gone=row_count;
  _disputes_kept:=0;
 else
  select count(*) into _retained from clinical_core.care_message_settlements s where s.sender_id=_actor;
  select count(*) into _signatures_kept from clinical_core.document_signatures s
   where s.signed_by_person_id=_actor;
  -- The packet is the clinic's record that it asked, so a domain erase keeps it, exactly as
  -- it keeps a thread the clinic has written in.
  select count(*) into _packets_kept from clinical_core.intake_packets p
   join clinical_core.patient_connections c on c.id=p.connection_id
   where c.consumer_person_id=_actor;
  select count(*) into _disputes_kept from clinical_core.clinical_disputes d
   join clinical_core.patient_connections c on c.id=d.connection_id
   where c.consumer_person_id=_actor;
 end if;

 insert into clinical_core.care_data_erasures(owner_id,scope,messages_erased,threads_erased,threads_retained,
  settlements_erased,settlements_retained,assignments_erased,late_admission_refusable,
  responses_erased,packets_retained,packets_erased,signatures_retained,signatures_erased,
  consult_requests_erased,dispute_statements_erased,disputes_retained,disputes_erased,
  revision_notices_erased)
 values(_actor,_scope,_messages,_threads,_kept,_settlements,_retained,_assignments,_scope='domain',
  _responses,_packets_kept,_packets_gone,_signatures_kept,_signatures_gone,_consults,
  _statements,_disputes_kept,_disputes_gone,_notices_gone)
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
  'disputeStatementsErased',_statements,
  'disputesRetained',_disputes_kept,'disputesErased',_disputes_gone,
  'revisionNoticesErased',_notices_gone,
  'lateAdmissionRefusable',_scope='domain',
  'retainedReason',case when _scope='domain' and _retained>0
   then 'cancellation_refusal_must_outlive_late_admission' else null end,
  'threadsRetainedReason',case when _kept>0 then 'thread_holds_another_participant_record' else null end,
  'packetsRetainedReason',case when _packets_kept>0
   then 'packet_is_the_clinic_record_of_what_was_asked' else null end,
  'signaturesRetainedReason',case when _signatures_kept>0
   then 'signature_is_the_recorded_basis_for_care_already_given' else null end,
  'disputesRetainedReason',case when _disputes_kept>0
   then 'dispute_records_a_decision_and_the_disagreement_with_it' else null end);
end $$;
revoke all on function clinical_core.care_data_erase(jsonb) from public;
revoke all on function clinical_core.care_data_erase(jsonb) from clinical_core_api;

create table clinical_core.care_data_erasure_requests (
 owner_id uuid not null references clinical_core.persons(id),
 request_id uuid not null,
 scope text not null check(scope in('domain','account_closure')),
 outcome text not null check(outcome in('erased','cancelled')),
 receipt jsonb,
 settled_at timestamptz not null default now(),
 primary key(owner_id,request_id),
 check((outcome='erased' and receipt is not null and receipt->>'action'='erase'
   and receipt->>'scope'=scope) or (outcome='cancelled' and receipt is null))
);
alter table clinical_core.care_data_erasure_requests enable row level security;
revoke all on clinical_core.care_data_erasure_requests from public,clinical_core_api;
create trigger care_data_erasure_requests_immutable before update or delete
 on clinical_core.care_data_erasure_requests for each row
 execute function clinical_private.care_data_immutable();

-- No raw table grant. The definer applies the owner predicate, active identity and
-- synthetic boundary even to receipt reads after a clinic connection is withdrawn.
create function clinical_core.care_data_erasure_request(_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 _actor uuid:=clinical_private.actor_person_id(); _org uuid:=clinical_private.organization_id();
 _action text:=_request->>'action'; _scope text:=_request->>'scope'; _id uuid;
 _prior clinical_core.care_data_erasure_requests%rowtype; _receipt jsonb;
begin
 perform clinical_private.assert_synthetic_context(_org,'consent_management');
 if _actor is null or clinical_private.claim('identity_pool')<>'consumer'
 or not exists(select 1 from clinical_core.identities i join clinical_core.persons p on p.id=i.person_id
   where i.person_id=_actor and i.identity_pool='consumer'
   and i.identity_subject=clinical_private.claim('identity_subject')
   and i.status='active' and p.status='active' and i.synthetic_attested) then
  raise exception using errcode='42501',message='care_data_forbidden'; end if;
 if _request is null or clinical_private.jsonb_kind(_request)<>'object'
 or _request-array['action','scope','requestId']<>'{}'::jsonb
 or _action is null or _action not in('erase_request','erase_receipt','settle_erasure')
 or _scope is null or _scope not in('domain','account_closure')
 or coalesce(_request->>'requestId','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' then
  raise exception using errcode='22023',message='care_data_invalid'; end if;
 _id:=(_request->>'requestId')::uuid;
 -- The exact same owner lock as the actual erase. No network work inside this lock.
 perform pg_advisory_xact_lock(hashtextextended(_actor::text,0));
 select * into _prior from clinical_core.care_data_erasure_requests
  where owner_id=_actor and request_id=_id;
 if found then
  if _prior.scope<>_scope then
   raise exception using errcode='23505',message='care_data_conflict'; end if;
  return jsonb_build_object('action',_action,'requestId',_id,'scope',_scope,
   'outcome',_prior.outcome,'receipt',_prior.receipt);
 end if;
 if _action='erase_receipt' then
  -- Absence is unresolved: the original may not have arrived yet. A read is not a fence.
  return jsonb_build_object('action',_action,'requestId',_id,'scope',_scope,
   'outcome','unresolved','receipt',null);
 elsif _action='settle_erasure' then
  insert into clinical_core.care_data_erasure_requests(owner_id,request_id,scope,outcome)
   values(_actor,_id,_scope,'cancelled');
  return jsonb_build_object('action',_action,'requestId',_id,'scope',_scope,
   'outcome','cancelled','receipt',null);
 end if;
 _receipt:=clinical_core.care_data_erase(jsonb_build_object('action','erase','scope',_scope));
 insert into clinical_core.care_data_erasure_requests(owner_id,request_id,scope,outcome,receipt)
  values(_actor,_id,_scope,'erased',_receipt);
 return jsonb_build_object('action',_action,'requestId',_id,'scope',_scope,
  'outcome','erased','receipt',_receipt);
end $$;
revoke all on function clinical_core.care_data_erasure_request(jsonb) from public;
grant execute on function clinical_core.care_data_erasure_request(jsonb) to clinical_core_api;
