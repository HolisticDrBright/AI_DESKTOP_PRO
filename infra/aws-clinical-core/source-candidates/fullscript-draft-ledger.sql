-- UNRELEASED source candidate. Not in the synthetic/production/qualification
-- migration manifests. Installing it does not authorize provider calls or PHI.
-- No API role receives access. A reviewed same-target authority adapter and
-- separately reviewed worker deployment are required before runtime wiring.
create schema fullscript_delivery;
revoke all on schema fullscript_delivery from public;
create role fullscript_draft_worker nologin;
grant usage on schema fullscript_delivery to fullscript_draft_worker;

create table fullscript_delivery.draft_intents (
 id uuid primary key,
 organization_id uuid not null,
 consumer_person_id uuid not null,
 patient_record_id uuid not null,
 connection_id uuid not null,
 practitioner_person_id uuid not null,
 manifest_id uuid not null,
 authority_sha256 text not null check(authority_sha256 ~ '^[a-f0-9]{64}$' and authority_sha256 <> repeat('0',64)),
 intent_sha256 text not null check(intent_sha256 ~ '^[a-f0-9]{64}$' and intent_sha256 <> repeat('0',64)),
 input jsonb not null check(jsonb_typeof(input)='object'),
 excluded_count integer not null check(excluded_count>=0),
 state text not null default 'prepared' check(state in ('prepared','dispatching','uncertain','verified','cancelled','withheld')),
 writer_id uuid,
 writer_actor jsonb,
 writer_deadline timestamptz,
 writer_settled boolean not null default false,
 provider_plan_id text check(provider_plan_id ~ '^[A-Za-z0-9-]{8,128}$'),
 receipt_sha256 text check(receipt_sha256 ~ '^[a-f0-9]{64}$'),
 issued_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 unique(organization_id,intent_sha256),
 unique(organization_id,provider_plan_id),
 check((writer_id is null)=(writer_deadline is null)),
 check((writer_id is null)=(writer_actor is null)),
 check(state not in ('dispatching','uncertain','verified') or writer_id is not null),
 -- A reconciliation receipt can precede writer settlement. It is not proof
 -- that an admitted writer stopped, that a provider draft was erased, or that
 -- cleanup may be certified. The service exposes writerPending separately.
 check(state<>'verified' or (provider_plan_id is not null and receipt_sha256 is not null)),
 check((provider_plan_id is null)=(receipt_sha256 is null))
);
create index draft_intents_owner_idx on fullscript_delivery.draft_intents(organization_id,consumer_person_id,issued_at,id);
create index draft_intents_unsettled_idx on fullscript_delivery.draft_intents(writer_deadline,id) where writer_id is not null and not writer_settled;
revoke all on fullscript_delivery.draft_intents from public;
grant select,insert,update on fullscript_delivery.draft_intents to fullscript_draft_worker;

-- Receipt/intents are recipient-specific records, NOT the anonymous cart
-- manifest. No DELETE grant: privacy/hold-aware cleanup must be designed and
-- released before this candidate can be activated.
create function fullscript_delivery.protect_intent() returns trigger
language plpgsql set search_path='' as $$
begin
 if tg_op='INSERT' then
  if new.state<>'prepared' or new.writer_id is not null or new.writer_actor is not null
   or new.writer_deadline is not null or new.writer_settled or new.provider_plan_id is not null
   or new.receipt_sha256 is not null then raise exception 'fullscript_initial_state_refused'; end if;
  return new;
 end if;
 if tg_op='DELETE' then raise exception 'fullscript_intent_immutable'; end if;
 if row(new.id,new.organization_id,new.consumer_person_id,new.patient_record_id,
  new.connection_id,new.practitioner_person_id,new.manifest_id,new.authority_sha256,
  new.intent_sha256,new.input,new.excluded_count,new.issued_at)
  is distinct from row(old.id,old.organization_id,old.consumer_person_id,old.patient_record_id,
  old.connection_id,old.practitioner_person_id,old.manifest_id,old.authority_sha256,
  old.intent_sha256,old.input,old.excluded_count,old.issued_at)
 then raise exception 'fullscript_intent_immutable'; end if;
 if old.writer_id is not null and row(new.writer_id,new.writer_deadline,new.writer_actor) is distinct from row(old.writer_id,old.writer_deadline,old.writer_actor)
 then raise exception 'fullscript_writer_immutable'; end if;
 if old.writer_settled and not new.writer_settled then raise exception 'fullscript_writer_immutable'; end if;
 if old.provider_plan_id is not null and row(new.provider_plan_id,new.receipt_sha256) is distinct from row(old.provider_plan_id,old.receipt_sha256)
 then raise exception 'fullscript_receipt_immutable'; end if;
 if new.state<>old.state and not (
  (old.state='prepared' and new.state in ('dispatching','cancelled','withheld')) or
  (old.state='dispatching' and new.state in ('uncertain','verified','withheld')) or
  (old.state='uncertain' and new.state in ('verified','withheld')) or
  (old.state='verified' and new.state='withheld'))
 then raise exception 'fullscript_transition_refused'; end if;
 if old.writer_id is null and new.writer_id is not null and not (old.state='prepared' and new.state='dispatching')
 then raise exception 'fullscript_transition_refused'; end if;
 new.updated_at:=clock_timestamp();
 return new;
end $$;
revoke all on function fullscript_delivery.protect_intent() from public;
create trigger protect_draft_intent before insert or update or delete on fullscript_delivery.draft_intents
 for each row execute function fullscript_delivery.protect_intent();

-- Recipient-specific, identifier-only history. It is not a provider deletion
-- receipt. The worker cannot read, insert, rewrite or delete raw audit rows.
-- Caller context is set only AFTER same-transaction authority checks. A late
-- provider result is attributed to the persisted admitted writer, not falsely
-- to a newly authenticated caller or a currently active practitioner.
create table fullscript_delivery.draft_events (
 event_id bigint generated always as identity primary key,
 intent_id uuid not null references fullscript_delivery.draft_intents(id),
 organization_id uuid not null,
 actor_person_id uuid not null,
 actor_pool text not null check(actor_pool in ('consumer','workforce')),
 actor_source text not null check(actor_source in ('caller','admitted_writer')),
 action text not null check(action in ('prepared','transition','custody','status_read','owner_export_read')),
 previous_state text,
 next_state text not null,
 writer_pending boolean not null,
 provider_receipt_known boolean not null,
 happened_at timestamptz not null default clock_timestamp()
);
create index draft_events_intent_page_idx on fullscript_delivery.draft_events(intent_id,event_id desc);
revoke all on fullscript_delivery.draft_events from public,fullscript_draft_worker;

create function fullscript_delivery.audit_actor(_intent fullscript_delivery.draft_intents) returns jsonb
language plpgsql set search_path='' as $$
declare a jsonb;
begin
 a:=nullif(current_setting('alp.fullscript_audit_actor',true),'')::jsonb;
 if current_setting('role',true) is distinct from 'fullscript_draft_worker'
  or a is null or jsonb_typeof(a)<>'object' or (select count(*) from jsonb_object_keys(a))<>4
  or (a->>'organizationId')::uuid is distinct from _intent.organization_id
  or coalesce(a->>'identityPool','') not in ('consumer','workforce')
  or coalesce(a->>'source','') not in ('caller','admitted_writer')
  or (a->>'personId')::uuid is null then raise exception 'fullscript_audit_actor_required'; end if;
 if a->>'identityPool'='consumer' and (a->>'personId')::uuid<>_intent.consumer_person_id
  then raise exception 'fullscript_audit_actor_required'; end if;
 if a->>'source'='admitted_writer' and (a->>'identityPool'<>'workforce'
  or (a->>'personId')::uuid is distinct from (_intent.writer_actor->>'personId')::uuid)
  then raise exception 'fullscript_audit_actor_required'; end if;
 return a;
exception when others then raise exception 'fullscript_audit_actor_required';
end $$;
revoke all on function fullscript_delivery.audit_actor(fullscript_delivery.draft_intents) from public,fullscript_draft_worker;

create function fullscript_delivery.audit_draft_change() returns trigger
language plpgsql security definer set search_path='' as $$
declare a jsonb; prior text; event_action text;
begin
 if tg_op='UPDATE' and row(new.state,new.writer_id,new.writer_settled,new.provider_plan_id,new.receipt_sha256)
  is not distinct from row(old.state,old.writer_id,old.writer_settled,old.provider_plan_id,old.receipt_sha256)
  then return new; end if;
 a:=fullscript_delivery.audit_actor(new);
 prior:=case when tg_op='INSERT' then null else old.state end;
 event_action:=case when tg_op='INSERT' then 'prepared' when old.state<>new.state then 'transition' else 'custody' end;
 insert into fullscript_delivery.draft_events(intent_id,organization_id,actor_person_id,actor_pool,actor_source,
  action,previous_state,next_state,writer_pending,provider_receipt_known)
 values(new.id,new.organization_id,(a->>'personId')::uuid,a->>'identityPool',a->>'source',event_action,
  prior,new.state,new.writer_id is not null and not new.writer_settled,new.provider_plan_id is not null);
 return new;
end $$;
revoke all on function fullscript_delivery.audit_draft_change() from public,fullscript_draft_worker;
create trigger audit_draft_change after insert or update on fullscript_delivery.draft_intents
 for each row execute function fullscript_delivery.audit_draft_change();

create function fullscript_delivery.protect_draft_event() returns trigger
language plpgsql set search_path='' as $$
begin raise exception 'fullscript_audit_immutable'; end $$;
revoke all on function fullscript_delivery.protect_draft_event() from public,fullscript_draft_worker;
create trigger protect_draft_event before update or delete on fullscript_delivery.draft_events
 for each row execute function fullscript_delivery.protect_draft_event();

-- Only the original owner may export this history; a replacement connection
-- never changes the immutable owner. API wiring must still authenticate the
-- actual issuer and use the mandatory canonical authority before setting the
-- private worker context. These functions are not public identity endpoints.
create function fullscript_delivery.owner_event_page(_id uuid,_before bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare item fullscript_delivery.draft_intents; a jsonb; events jsonb; more boolean; next_id text;
begin
 select * into item from fullscript_delivery.draft_intents where id=_id for share;
 if not found then raise exception 'fullscript_delivery_refused'; end if;
 a:=fullscript_delivery.audit_actor(item);
 if a->>'source'<>'caller' or a->>'identityPool'<>'consumer'
  or (a->>'personId')::uuid<>item.consumer_person_id or (_before is not null and _before<=0)
  then raise exception 'fullscript_delivery_refused'; end if;
 with page as (select * from fullscript_delivery.draft_events
  where intent_id=_id and (_before is null or event_id<_before) order by event_id desc limit 101),
 visible as (select * from page order by event_id desc limit 100)
 select coalesce((select jsonb_agg(jsonb_build_object('eventId',event_id::text,'action',action,
   'actorPersonId',actor_person_id,'actorPool',actor_pool,'actorSource',actor_source,
   'previousState',previous_state,'nextState',next_state,'writerPending',writer_pending,
   'providerReceiptKnown',provider_receipt_known,'happenedAt',happened_at) order by event_id desc) from visible),'[]'::jsonb),
  (select count(*)>100 from page),(select min(event_id)::text from visible) into events,more,next_id;
 return jsonb_build_object('events',events,'nextBefore',case when more then next_id else null end);
end $$;
revoke all on function fullscript_delivery.owner_event_page(uuid,bigint) from public;
grant execute on function fullscript_delivery.owner_event_page(uuid,bigint) to fullscript_draft_worker;

create function fullscript_delivery.record_draft_access(_id uuid,_action text) returns void
language plpgsql security definer set search_path='' as $$
declare item fullscript_delivery.draft_intents; a jsonb;
begin
 select * into item from fullscript_delivery.draft_intents where id=_id for share;
 if not found then raise exception 'fullscript_delivery_refused'; end if;
 a:=fullscript_delivery.audit_actor(item);
 if a->>'source'<>'caller' or _action not in ('status_read','owner_export_read') or _action is null
  or (_action='owner_export_read' and (a->>'identityPool'<>'consumer'
   or (a->>'personId')::uuid<>item.consumer_person_id)) then raise exception 'fullscript_delivery_refused'; end if;
 insert into fullscript_delivery.draft_events(intent_id,organization_id,actor_person_id,actor_pool,actor_source,
  action,next_state,writer_pending,provider_receipt_known)
 values(item.id,item.organization_id,(a->>'personId')::uuid,a->>'identityPool','caller',_action,item.state,
  item.writer_id is not null and not item.writer_settled,item.provider_plan_id is not null);
end $$;
revoke all on function fullscript_delivery.record_draft_access(uuid,text) from public;
grant execute on function fullscript_delivery.record_draft_access(uuid,text) to fullscript_draft_worker;
