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
