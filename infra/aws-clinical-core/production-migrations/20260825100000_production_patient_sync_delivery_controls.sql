-- Durable, function-only App -> Desktop transfer controls. This migration seeds
-- no rows and does not register or activate a delivery worker.

create table clinical_core.sync_outbound_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null references clinical_core.patient_records(id),
  connection_id uuid not null references clinical_core.patient_connections(id),
  provider_id uuid not null references clinical_core.sync_providers(id),
  resource_type text not null check (resource_type in
    ('protocol_version','appointment_summary','lab_summary','resource_withdrawal')),
  resource_id uuid not null,
  consent_scope text not null check (consent_scope in
    ('protocols_supplements','appointments','lab_summaries')),
  resource_version text not null check (char_length(resource_version) between 1 and 64),
  generation integer not null default 1 check (generation > 0),
  payload jsonb not null check (jsonb_typeof(payload)='object'
    and octet_length(payload::text) between 2 and 262144),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  idempotency_key text not null check (idempotency_key ~ '^[0-9a-f]{64}$'),
  state text not null default 'queued' check (state in
    ('queued','delivering','delivered','failed','dead_letter','cancelled')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 100),
  error_code_safe text check (error_code_safe is null or error_code_safe ~ '^[a-z0-9_]{1,64}$'),
  queued_by_person_id uuid not null references clinical_core.persons(id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  delivered_at timestamptz,
  cancelled_at timestamptz,
  foreign key (connection_id,organization_id,patient_record_id)
    references clinical_core.patient_connections(id,organization_id,patient_record_id),
  unique (connection_id,idempotency_key),
  unique (id,organization_id,patient_record_id)
);
create index sync_outbound_queue_idx on clinical_core.sync_outbound_events(
  provider_id,state,created_at) where state in ('queued','failed','dead_letter');

create table clinical_core.sync_inbound_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null references clinical_core.patient_records(id),
  connection_id uuid not null references clinical_core.patient_connections(id),
  provider_id uuid not null references clinical_core.sync_providers(id),
  provider_event_id text not null check (provider_event_id ~ '^[A-Za-z0-9:_-]{8,160}$'),
  resource_type text not null check (resource_type in
    ('lab_result','patient_message','symptom_checkin','adherence_checkin')),
  resource_version text not null check (char_length(resource_version) between 1 and 64),
  payload jsonb not null check (jsonb_typeof(payload)='object'
    and octet_length(payload::text) between 2 and 262144),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  state text not null default 'review_pending' check (state in
    ('review_pending','accepted','rejected','conflict')),
  received_at timestamptz not null default clock_timestamp(),
  reviewed_at timestamptz,
  reviewed_by_person_id uuid references clinical_core.persons(id),
  foreign key (connection_id,organization_id,patient_record_id)
    references clinical_core.patient_connections(id,organization_id,patient_record_id),
  unique (provider_id,provider_event_id),
  unique (id,organization_id,patient_record_id)
);
create index sync_inbound_review_idx on clinical_core.sync_inbound_events(
  organization_id,state,received_at) where state in ('review_pending','conflict');

create table clinical_core.sync_inbound_corrections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null references clinical_core.patient_records(id),
  inbound_event_id uuid not null references clinical_core.sync_inbound_events(id),
  version integer not null check (version > 0),
  overlay jsonb not null check (jsonb_typeof(overlay)='object'
    and octet_length(overlay::text) between 2 and 16384),
  reason text not null check (char_length(btrim(reason)) between 1 and 1000),
  recorded_by_person_id uuid not null references clinical_core.persons(id),
  recorded_at timestamptz not null default clock_timestamp(),
  unique (inbound_event_id,version)
);

create table clinical_core.sync_dead_letters (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null references clinical_core.patient_records(id),
  outbound_event_id uuid not null references clinical_core.sync_outbound_events(id),
  error_code_safe text not null check (error_code_safe ~ '^[a-z0-9_]{1,64}$'),
  created_at timestamptz not null default clock_timestamp(),
  retried_at timestamptz,
  retried_by_person_id uuid references clinical_core.persons(id),
  unique (outbound_event_id)
);

create table clinical_core.sync_conflicts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null references clinical_core.patient_records(id),
  connection_id uuid not null references clinical_core.patient_connections(id),
  inbound_event_id uuid references clinical_core.sync_inbound_events(id),
  outbound_event_id uuid references clinical_core.sync_outbound_events(id),
  conflict_type text not null check (conflict_type in
    ('version_mismatch','concurrent_change','duplicate_identity','unsupported_transition')),
  state text not null default 'open' check (state in
    ('open','resolved_keep_desktop','resolved_keep_external','resolved_manual','dismissed')),
  version integer not null default 1 check (version > 0),
  resolution_note text check (resolution_note is null or char_length(resolution_note) between 1 and 1000),
  created_at timestamptz not null default clock_timestamp(),
  resolved_at timestamptz,
  resolved_by_person_id uuid references clinical_core.persons(id),
  check (inbound_event_id is not null or outbound_event_id is not null),
  foreign key (connection_id,organization_id,patient_record_id)
    references clinical_core.patient_connections(id,organization_id,patient_record_id)
);

create table clinical_core.sync_resource_acks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null references clinical_core.patient_records(id),
  connection_id uuid not null references clinical_core.patient_connections(id),
  resource_type text not null,
  resource_id uuid not null,
  state text not null default 'pending' check (state in ('pending','acknowledged','withdrawn','failed')),
  last_outbound_event_id uuid references clinical_core.sync_outbound_events(id),
  updated_at timestamptz not null default clock_timestamp(),
  unique (connection_id,resource_type,resource_id),
  foreign key (connection_id,organization_id,patient_record_id)
    references clinical_core.patient_connections(id,organization_id,patient_record_id)
);

alter table clinical_core.sync_outbound_events enable row level security;
alter table clinical_core.sync_inbound_events enable row level security;
alter table clinical_core.sync_inbound_corrections enable row level security;
alter table clinical_core.sync_dead_letters enable row level security;
alter table clinical_core.sync_conflicts enable row level security;
alter table clinical_core.sync_resource_acks enable row level security;
revoke all on clinical_core.sync_outbound_events, clinical_core.sync_inbound_events,
  clinical_core.sync_inbound_corrections, clinical_core.sync_dead_letters,
  clinical_core.sync_conflicts, clinical_core.sync_resource_acks from public,clinical_core_api;

create or replace function clinical_private.protect_sync_event_identity()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if new.organization_id<>old.organization_id or new.patient_record_id<>old.patient_record_id
    or new.connection_id<>old.connection_id or new.provider_id<>old.provider_id
    or new.resource_type<>old.resource_type or new.resource_id<>old.resource_id
    or new.consent_scope<>old.consent_scope or new.resource_version<>old.resource_version
    or new.generation<>old.generation or new.payload<>old.payload
    or new.payload_sha256<>old.payload_sha256 or new.idempotency_key<>old.idempotency_key
    or new.queued_by_person_id<>old.queued_by_person_id or new.created_at<>old.created_at then
    raise exception using errcode='55000',message='sync_event_content_immutable';
  end if;
  return new;
end $$;
create trigger sync_outbound_event_identity_immutable before update on clinical_core.sync_outbound_events
  for each row execute function clinical_private.protect_sync_event_identity();

create or replace function clinical_private.protect_sync_inbound_identity()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if new.organization_id<>old.organization_id or new.patient_record_id<>old.patient_record_id
    or new.connection_id<>old.connection_id or new.provider_id<>old.provider_id
    or new.provider_event_id<>old.provider_event_id or new.resource_type<>old.resource_type
    or new.resource_version<>old.resource_version or new.payload<>old.payload
    or new.payload_sha256<>old.payload_sha256 or new.received_at<>old.received_at then
    raise exception using errcode='55000',message='sync_inbound_content_immutable';
  end if;
  return new;
end $$;
create trigger sync_inbound_event_identity_immutable before update on clinical_core.sync_inbound_events
  for each row execute function clinical_private.protect_sync_inbound_identity();

create or replace function clinical_private.protect_sync_append_only()
returns trigger language plpgsql security invoker set search_path='' as $$
begin raise exception using errcode='55000',message='sync_record_append_only'; end $$;
create trigger sync_inbound_event_no_delete before delete on clinical_core.sync_inbound_events
  for each row execute function clinical_private.protect_sync_append_only();
create trigger sync_inbound_corrections_append_only before update or delete on clinical_core.sync_inbound_corrections
  for each row execute function clinical_private.protect_sync_append_only();
create trigger sync_dead_letters_no_delete before delete on clinical_core.sync_dead_letters
  for each row execute function clinical_private.protect_sync_append_only();

alter table clinical_core.review_queue_items drop constraint review_queue_items_item_type_check;
alter table clinical_core.review_queue_items add constraint review_queue_items_item_type_check check (item_type in (
  'lab_extraction','abnormal_result','reasoning_snapshot','hypothesis','recommendation',
  'supplement_interaction','protocol','experiment','assessment','patient_message','safety_alert',
  'refill_request','low_adherence','overdue_followup','sync_inbound','sync_conflict'));

alter table clinical_audit.events drop constraint events_action_check;
alter table clinical_audit.events add constraint events_action_check check (action in (
  'connection.invitation_issued','connection.invitation_claimed','connection.paused','connection.resumed',
  'connection.revoked','consent.granted','consent.revoked','lab_import.received','lab_import.duplicate',
  'lab_import.accepted','lab_import.rejected','clinical_record.received','clinical_record.duplicate',
  'privacy_request.submitted','patient.created','lab_observation.reviewed','marker.view','document.viewed',
  'document.exported','report.exported','audit.exported','membership.role_changed','membership.suspended',
  'review_task.created','review_task.resolved','appointment.booked','appointment.rescheduled',
  'appointment.status_changed','appointment.corrected','encounter.started','encounter.completed',
  'encounter.cancelled','encounter.entered_in_error','note.draft_created','note.draft_saved',
  'note.ready_for_review','note.signed','note.addendum_created','note.entered_in_error',
  'protocol.draft_created','protocol.draft_saved','protocol.approved','protocol.activated',
  'protocol.paused','protocol.completed','protocol.discontinued','protocol.revision_created',
  'sync.export_queued','sync.resource_withdrawal_queued','sync.event_retried','sync.event_cancelled',
  'sync.inbound_accepted','sync.inbound_rejected','sync.inbound_correction_recorded','sync.conflict_resolved'));
alter table clinical_audit.events drop constraint events_resource_type_check;
alter table clinical_audit.events add constraint events_resource_type_check check (resource_type in (
  'connection','consent','lab_import','clinical_record','privacy_request','patient_profile',
  'lab_observation','biomarker_observation','lab_document','report','audit_log',
  'organization_membership','review_queue_item','appointment','encounter','clinical_note',
  'patient_protocol','patient_protocol_version','sync_outbound_event','sync_inbound_event',
  'sync_inbound_correction','sync_conflict'));

create or replace function clinical_private.sync_scope_for(_resource_type text)
returns text language sql immutable security invoker set search_path='' as $$
  select case _resource_type when 'protocol_version' then 'protocols_supplements'
    when 'appointment_summary' then 'appointments' when 'lab_summary' then 'lab_summaries' end
$$;

create or replace function clinical_private.build_sync_payload(
  _organization_id uuid,_patient_id uuid,_resource_type text,_resource_id uuid
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare _payload jsonb;
begin
  perform clinical_private.require_clinical_patient(_organization_id,_patient_id);
  if _resource_type='protocol_version' then
    if not exists(select 1 from clinical_core.patient_protocol_versions v
      where v.id=_resource_id and v.organization_id=_organization_id and v.patient_record_id=_patient_id
        and v.status in ('approved','active')) then
      raise exception using errcode='55000',message='approved_protocol_version_required'; end if;
    if exists(select 1 from clinical_core.patient_protocol_items i
      where i.protocol_version_id=_resource_id and i.kind='product') then
      raise exception using errcode='55000',message='governed_product_review_required'; end if;
    _payload:=jsonb_build_object('contractVersion','patient-sync/1','resourceType',_resource_type,
      'resourceId',_resource_id,'record',clinical_private.patient_protocol_version_json(_resource_id));
  elsif _resource_type='appointment_summary' then
    select jsonb_build_object('contractVersion','patient-sync/1','resourceType',_resource_type,
      'resourceId',a.id,'record',jsonb_build_object('id',a.id,'type',a.appointment_type,
        'status',a.status,'startsAt',a.starts_at,'endsAt',a.ends_at,'location',a.location,
        'version',a.version)) into _payload from clinical_core.appointments a
      where a.id=_resource_id and a.organization_id=_organization_id
        and a.patient_record_id=_patient_id and a.deleted_at is null;
  elsif _resource_type='lab_summary' and _resource_id=_patient_id then
    select jsonb_build_object('contractVersion','patient-sync/1','resourceType',_resource_type,
      'resourceId',_patient_id,'record',jsonb_build_object('observationCount',count(*),
        'lastCollectedAt',max(o.collected_at))) into _payload from clinical_core.lab_observations o
      where o.organization_id=_organization_id and o.patient_record_id=_patient_id;
  else raise exception using errcode='55000',message='resource_not_production_ready';
  end if;
  if _payload is null then raise exception using errcode='P0002',message='sync_resource_not_found'; end if;
  return _payload;
end $$;

create or replace function clinical_core.queue_sync_export(
  _connection_id uuid,_resource_type text,_resource_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare _c clinical_core.patient_connections%rowtype; _provider uuid; _scope text;
  _payload jsonb; _hash text; _key text; _generation integer; _event uuid; _actor uuid:=clinical_private.actor_person_id();
begin
  select * into _c from clinical_core.patient_connections where id=_connection_id for update;
  if not found then raise exception using errcode='P0002',message='connection_not_found'; end if;
  perform clinical_private.assert_production_context(_c.organization_id,'clinical_data','workforce');
  if not clinical_private.has_clinical_role(_c.organization_id) then raise exception using errcode='42501',message='clinical_role_required'; end if;
  if _c.state<>'verified' then raise exception using errcode='55000',message='verified_connection_required'; end if;
  select id into _provider from clinical_core.sync_providers where organization_id=_c.organization_id
    and stable_id='alp_patient_sync' and state='active';
  if _provider is null then raise exception using errcode='55000',message='active_sync_provider_required'; end if;
  _scope:=clinical_private.sync_scope_for(_resource_type);
  if _scope is null then raise exception using errcode='55000',message='resource_not_production_ready'; end if;
  if not exists(select 1 from clinical_core.current_consent where connection_id=_c.id
    and scope=_scope and status='granted') then raise exception using errcode='42501',message='consent_required'; end if;
  _payload:=clinical_private.build_sync_payload(_c.organization_id,_c.patient_record_id,_resource_type,_resource_id);
  _hash:=encode(public.digest(convert_to(_payload::text,'UTF8'),'sha256'),'hex');
  select coalesce(max(generation),0)+1 into _generation from clinical_core.sync_outbound_events
    where connection_id=_c.id and resource_type=_resource_type and resource_id=_resource_id;
  _key:=encode(public.digest(convert_to(_c.id::text||':'||_resource_type||':'||_resource_id::text||':'||_hash||':'||_generation::text,'UTF8'),'sha256'),'hex');
  update clinical_core.sync_outbound_events set state='cancelled',cancelled_at=clock_timestamp(),updated_at=clock_timestamp()
    where connection_id=_c.id and resource_type=_resource_type and resource_id=_resource_id
      and state in ('queued','failed','dead_letter');
  insert into clinical_core.sync_outbound_events(organization_id,patient_record_id,connection_id,provider_id,
    resource_type,resource_id,consent_scope,resource_version,generation,payload,payload_sha256,idempotency_key,queued_by_person_id)
    values(_c.organization_id,_c.patient_record_id,_c.id,_provider,_resource_type,_resource_id,_scope,
      _generation::text,_generation,_payload,_hash,_key,_actor) returning id into _event;
  insert into clinical_core.sync_resource_acks(organization_id,patient_record_id,connection_id,resource_type,
    resource_id,state,last_outbound_event_id) values(_c.organization_id,_c.patient_record_id,_c.id,
      _resource_type,_resource_id,'pending',_event) on conflict(connection_id,resource_type,resource_id)
    do update set state='pending',last_outbound_event_id=excluded.last_outbound_event_id,updated_at=clock_timestamp();
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
    patient_record_id,purpose,safe_metadata) values(_c.organization_id,_actor,'sync.export_queued',
      'sync_outbound_event',_event,_c.patient_record_id,'clinical_data',
      jsonb_build_object('resource_type',_resource_type,'scope',_scope,'generation',_generation));
  return jsonb_build_object('ok',true,'eventId',_event,'state','queued','generation',_generation,
    'deliveryEnabled',false,'message','Export queued; delivery worker is not active');
end $$;

create or replace function clinical_core.withdraw_sync_resource(
  _connection_id uuid,_resource_type text,_resource_id uuid,_reason text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare _c clinical_core.patient_connections%rowtype; _provider uuid; _scope text; _event uuid;
  _payload jsonb; _hash text; _key text; _generation integer; _actor uuid:=clinical_private.actor_person_id();
begin
  if char_length(btrim(coalesce(_reason,''))) not between 1 and 500 then raise exception using errcode='22023',message='withdrawal_reason_required'; end if;
  select * into _c from clinical_core.patient_connections where id=_connection_id for update;
  if not found then raise exception using errcode='P0002',message='connection_not_found'; end if;
  perform clinical_private.assert_production_context(_c.organization_id,'clinical_data','workforce');
  if not clinical_private.has_clinical_role(_c.organization_id) then raise exception using errcode='42501',message='clinical_role_required'; end if;
  if _c.state not in ('verified','paused') then raise exception using errcode='55000',message='connected_patient_required'; end if;
  select id into _provider from clinical_core.sync_providers where organization_id=_c.organization_id
    and stable_id='alp_patient_sync' and state='active';
  if _provider is null then raise exception using errcode='55000',message='active_sync_provider_required'; end if;
  _scope:=clinical_private.sync_scope_for(_resource_type);
  if _scope is null then raise exception using errcode='55000',message='resource_not_production_ready'; end if;
  select coalesce(max(generation),0)+1 into _generation from clinical_core.sync_outbound_events
    where connection_id=_c.id and resource_type in (_resource_type,'resource_withdrawal') and resource_id=_resource_id;
  _payload:=jsonb_build_object('contractVersion','patient-sync/1','resourceType','resource_withdrawal',
    'withdrawsResourceType',_resource_type,'resourceId',_resource_id,'generation',_generation);
  _hash:=encode(public.digest(convert_to(_payload::text,'UTF8'),'sha256'),'hex');
  _key:=encode(public.digest(convert_to(_c.id::text||':withdraw:'||_resource_type||':'||_resource_id::text||':'||_generation::text,'UTF8'),'sha256'),'hex');
  insert into clinical_core.sync_outbound_events(organization_id,patient_record_id,connection_id,provider_id,
    resource_type,resource_id,consent_scope,resource_version,generation,payload,payload_sha256,idempotency_key,queued_by_person_id)
    values(_c.organization_id,_c.patient_record_id,_c.id,_provider,'resource_withdrawal',_resource_id,_scope,
      _generation::text,_generation,_payload,_hash,_key,_actor) returning id into _event;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
    patient_record_id,purpose,safe_metadata) values(_c.organization_id,_actor,'sync.resource_withdrawal_queued',
      'sync_outbound_event',_event,_c.patient_record_id,'clinical_data',
      jsonb_build_object('resource_type',_resource_type,'reason_present',true));
  return jsonb_build_object('ok',true,'eventId',_event,'state','queued','acknowledged',false,
    'deliveryEnabled',false,'message','Withdrawal queued; acknowledgement is pending');
end $$;

create or replace function clinical_core.retry_sync_event(_event_id uuid,_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _e clinical_core.sync_outbound_events%rowtype; _actor uuid:=clinical_private.actor_person_id();
begin
  if char_length(btrim(coalesce(_reason,''))) not between 1 and 500 then raise exception using errcode='22023',message='retry_reason_required'; end if;
  select * into _e from clinical_core.sync_outbound_events where id=_event_id for update;
  if not found then raise exception using errcode='P0002',message='sync_event_not_found'; end if;
  perform clinical_private.assert_production_context(_e.organization_id,'clinical_data','workforce');
  if not clinical_private.has_clinical_role(_e.organization_id) then raise exception using errcode='42501',message='clinical_role_required'; end if;
  if _e.state not in ('failed','dead_letter') then raise exception using errcode='55000',message='failed_event_required'; end if;
  if not exists(select 1 from clinical_core.patient_connections c where c.id=_e.connection_id and c.state='verified')
    or not exists(select 1 from clinical_core.sync_providers p where p.id=_e.provider_id and p.state='active')
    or not exists(select 1 from clinical_core.current_consent c where c.connection_id=_e.connection_id
      and c.scope=_e.consent_scope and c.status='granted') then
    raise exception using errcode='55000',message='sync_retry_gate_closed'; end if;
  update clinical_core.sync_outbound_events set state='queued',error_code_safe=null,updated_at=clock_timestamp() where id=_e.id;
  update clinical_core.sync_dead_letters set retried_at=clock_timestamp(),retried_by_person_id=_actor where outbound_event_id=_e.id;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
    patient_record_id,purpose,safe_metadata) values(_e.organization_id,_actor,'sync.event_retried',
      'sync_outbound_event',_e.id,_e.patient_record_id,'clinical_data',jsonb_build_object('reason_present',true));
  return jsonb_build_object('ok',true,'eventId',_e.id,'state','queued','deliveryEnabled',false);
end $$;

create or replace function clinical_core.cancel_sync_event(_event_id uuid,_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _e clinical_core.sync_outbound_events%rowtype; _actor uuid:=clinical_private.actor_person_id();
begin
  if char_length(btrim(coalesce(_reason,''))) not between 1 and 500 then raise exception using errcode='22023',message='cancel_reason_required'; end if;
  select * into _e from clinical_core.sync_outbound_events where id=_event_id for update;
  if not found then raise exception using errcode='P0002',message='sync_event_not_found'; end if;
  perform clinical_private.assert_production_context(_e.organization_id,'clinical_data','workforce');
  if not clinical_private.has_clinical_role(_e.organization_id) then raise exception using errcode='42501',message='clinical_role_required'; end if;
  if _e.state not in ('queued','failed','dead_letter') then raise exception using errcode='55000',message='sync_event_not_cancellable'; end if;
  update clinical_core.sync_outbound_events set state='cancelled',cancelled_at=clock_timestamp(),updated_at=clock_timestamp() where id=_e.id;
  update clinical_core.sync_resource_acks set state='failed',updated_at=clock_timestamp() where last_outbound_event_id=_e.id and state='pending';
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
    patient_record_id,purpose,safe_metadata) values(_e.organization_id,_actor,'sync.event_cancelled',
      'sync_outbound_event',_e.id,_e.patient_record_id,'clinical_data',jsonb_build_object('reason_present',true));
  return jsonb_build_object('ok',true,'eventId',_e.id,'state','cancelled');
end $$;

create or replace function clinical_core.review_sync_inbound(_event_id uuid,_action text,_note text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _e clinical_core.sync_inbound_events%rowtype; _state text; _actor uuid:=clinical_private.actor_person_id();
begin
  if _action not in ('accept','reject') or (_action='reject' and char_length(btrim(coalesce(_note,''))) not between 1 and 500)
    or (_note is not null and char_length(_note)>500) then raise exception using errcode='22023',message='inbound_review_invalid'; end if;
  select * into _e from clinical_core.sync_inbound_events where id=_event_id for update;
  if not found then raise exception using errcode='P0002',message='sync_inbound_not_found'; end if;
  perform clinical_private.assert_production_context(_e.organization_id,'clinical_data','workforce');
  if not clinical_private.has_clinical_role(_e.organization_id) then raise exception using errcode='42501',message='clinical_role_required'; end if;
  if _e.state<>'review_pending' then raise exception using errcode='55000',message='inbound_review_pending_required'; end if;
  _state:=case when _action='accept' then 'accepted' else 'rejected' end;
  update clinical_core.sync_inbound_events set state=_state,reviewed_at=clock_timestamp(),reviewed_by_person_id=_actor where id=_e.id;
  update clinical_core.review_queue_items set status='resolved',updated_by_person_id=_actor,updated_at=clock_timestamp()
    where organization_id=_e.organization_id and item_type='sync_inbound' and reference_id=_e.id and status in ('open','in_review','snoozed');
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
    patient_record_id,purpose,safe_metadata) values(_e.organization_id,_actor,'sync.inbound_'||_state,
      'sync_inbound_event',_e.id,_e.patient_record_id,'clinical_data',jsonb_build_object('note_present',coalesce(char_length(btrim(_note)),0)>0));
  return jsonb_build_object('ok',true,'eventId',_e.id,'state',_state,
    'chartMaterialized',false,'message','Review recorded; chart materialization remains disabled');
end $$;

create or replace function clinical_core.record_sync_inbound_correction(
  _inbound_event_id uuid,_overlay jsonb,_reason text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare _e clinical_core.sync_inbound_events%rowtype; _version integer; _id uuid; _actor uuid:=clinical_private.actor_person_id();
begin
  if jsonb_typeof(_overlay)<>'object' or octet_length(_overlay::text) not between 2 and 16384
    or _overlay ?| array['authorization','cookie','password','access_token','refresh_token','service_role_key','secret',
      'affiliateUrl','destinationUrl','discountCode','trackingCode']
    or char_length(btrim(coalesce(_reason,''))) not between 1 and 1000 then
    raise exception using errcode='22023',message='inbound_correction_invalid'; end if;
  select * into _e from clinical_core.sync_inbound_events where id=_inbound_event_id for update;
  if not found then raise exception using errcode='P0002',message='sync_inbound_not_found'; end if;
  perform clinical_private.assert_production_context(_e.organization_id,'clinical_data','workforce');
  if not clinical_private.has_clinical_role(_e.organization_id) then raise exception using errcode='42501',message='clinical_role_required'; end if;
  if _e.state not in ('accepted','rejected') then raise exception using errcode='55000',message='reviewed_inbound_required'; end if;
  select coalesce(max(version),0)+1 into _version from clinical_core.sync_inbound_corrections where inbound_event_id=_e.id;
  insert into clinical_core.sync_inbound_corrections(organization_id,patient_record_id,inbound_event_id,
    version,overlay,reason,recorded_by_person_id) values(_e.organization_id,_e.patient_record_id,_e.id,
      _version,_overlay,btrim(_reason),_actor) returning id into _id;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
    patient_record_id,purpose,safe_metadata) values(_e.organization_id,_actor,'sync.inbound_correction_recorded',
      'sync_inbound_correction',_id,_e.patient_record_id,'clinical_data',jsonb_build_object('version',_version,'reason_present',true));
  return jsonb_build_object('ok',true,'correctionId',_id,'inboundEventId',_e.id,'version',_version);
end $$;

create or replace function clinical_core.resolve_sync_conflict(
  _conflict_id uuid,_resolution text,_note text,_expected_version integer
) returns jsonb language plpgsql security definer set search_path='' as $$
declare _c clinical_core.sync_conflicts%rowtype; _actor uuid:=clinical_private.actor_person_id();
begin
  if _resolution not in ('resolved_keep_desktop','resolved_keep_external','resolved_manual','dismissed')
    or char_length(btrim(coalesce(_note,''))) not between 1 and 1000 or _expected_version<1 then
    raise exception using errcode='22023',message='conflict_resolution_invalid'; end if;
  select * into _c from clinical_core.sync_conflicts where id=_conflict_id for update;
  if not found then raise exception using errcode='P0002',message='sync_conflict_not_found'; end if;
  perform clinical_private.assert_production_context(_c.organization_id,'clinical_data','workforce');
  if not clinical_private.has_clinical_role(_c.organization_id) then raise exception using errcode='42501',message='clinical_role_required'; end if;
  if _c.state<>'open' or _c.version<>_expected_version then raise exception using errcode='40001',message='sync_conflict_version_conflict'; end if;
  update clinical_core.sync_conflicts set state=_resolution,resolution_note=btrim(_note),resolved_at=clock_timestamp(),
    resolved_by_person_id=_actor,version=version+1 where id=_c.id returning * into _c;
  update clinical_core.review_queue_items set status='resolved',updated_by_person_id=_actor,updated_at=clock_timestamp()
    where organization_id=_c.organization_id and item_type='sync_conflict' and reference_id=_c.id and status in ('open','in_review','snoozed');
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,
    patient_record_id,purpose,safe_metadata) values(_c.organization_id,_actor,'sync.conflict_resolved',
      'sync_conflict',_c.id,_c.patient_record_id,'clinical_data',jsonb_build_object('resolution',_resolution,'reason_present',true));
  return jsonb_build_object('ok',true,'conflictId',_c.id,'state',_c.state,'version',_c.version);
end $$;

create or replace function clinical_private.cancel_sync_on_consent_revoke()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.status='revoked' then
    update clinical_core.sync_outbound_events set state='cancelled',cancelled_at=clock_timestamp(),updated_at=clock_timestamp()
      where connection_id=new.connection_id and consent_scope=new.scope and state in ('queued','failed','dead_letter');
    update clinical_core.sync_resource_acks set state='failed',updated_at=clock_timestamp()
      where connection_id=new.connection_id and state='pending' and resource_type in
        (select resource_type from clinical_core.sync_outbound_events where connection_id=new.connection_id and consent_scope=new.scope);
  end if;
  return new;
end $$;
create trigger consent_revoke_cancels_sync after insert on clinical_core.consent_grants
  for each row execute function clinical_private.cancel_sync_on_consent_revoke();

create or replace function clinical_core.get_patient_sync_overview(_patient_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _org uuid:=clinical_private.organization_id(); _c clinical_core.patient_connections%rowtype;
  _outbound jsonb; _inbound jsonb; _conflicts jsonb; _resources jsonb; _result jsonb;
begin
  perform clinical_private.require_clinical_patient(_org,_patient_id);
  select * into _c from clinical_core.patient_connections c where c.organization_id=_org
    and c.patient_record_id=_patient_id order by (c.state<>'revoked') desc,c.created_at desc limit 1;
  if _c.id is null then
    return jsonb_build_object('providerConfigured',exists(select 1 from clinical_core.sync_providers p
      where p.organization_id=_org and p.stable_id='alp_patient_sync' and p.state='active'),
      'connection',null,'counts',jsonb_build_object('pendingOutbound',0,'failedOutbound',0,
      'deadLetter',0,'inboundPendingReview',0,'openConflicts',0),'resources','[]'::jsonb,
      'outbound','[]'::jsonb,'inbound','[]'::jsonb,'conflicts','[]'::jsonb,'generatedAt',clock_timestamp());
  end if;
  select coalesce(jsonb_agg(x.item order by x.created_at desc),'[]'::jsonb) into _outbound from (
    select e.created_at,jsonb_build_object('id',e.id,'resourceType',e.resource_type,'resourceId',e.resource_id,
      'state',e.state,'generation',e.generation,'attemptCount',e.attempt_count,'createdAt',e.created_at,
      'deliveredAt',e.delivered_at,'cancelledAt',e.cancelled_at) item
    from clinical_core.sync_outbound_events e where e.connection_id=_c.id order by e.created_at desc limit 50) x;
  select coalesce(jsonb_agg(x.item order by x.received_at desc),'[]'::jsonb) into _inbound from (
    select e.received_at,jsonb_build_object('id',e.id,'resourceType',e.resource_type,'resourceVersion',e.resource_version,
      'state',e.state,'receivedAt',e.received_at,'reviewedAt',e.reviewed_at) item
    from clinical_core.sync_inbound_events e where e.connection_id=_c.id order by e.received_at desc limit 50) x;
  select coalesce(jsonb_agg(x.item order by x.created_at desc),'[]'::jsonb) into _conflicts from (
    select c.created_at,jsonb_build_object('id',c.id,'conflictType',c.conflict_type,'state',c.state,
      'version',c.version,'createdAt',c.created_at,'resolvedAt',c.resolved_at) item
    from clinical_core.sync_conflicts c where c.connection_id=_c.id order by c.created_at desc limit 50) x;
  select coalesce(jsonb_agg(jsonb_build_object('resourceType',a.resource_type,'resourceId',a.resource_id,
    'state',a.state,'updatedAt',a.updated_at) order by a.updated_at desc),'[]'::jsonb) into _resources
    from clinical_core.sync_resource_acks a where a.connection_id=_c.id;
  select clinical_core.get_org_sync_operations(_org) into _result;
  return jsonb_build_object('providerConfigured',_result->'providerConfigured','connection',jsonb_build_object(
    'id',_c.id,'state',_c.state,'contractVersion',_c.contract_version,'version',_c.version,
    'verifiedAt',_c.verified_at,'pausedAt',_c.paused_at,'revokedAt',_c.revoked_at),
    'counts',jsonb_build_object(
      'pendingOutbound',(select count(*) from clinical_core.sync_outbound_events e where e.connection_id=_c.id and e.state='queued'),
      'failedOutbound',(select count(*) from clinical_core.sync_outbound_events e where e.connection_id=_c.id and e.state='failed'),
      'deadLetter',(select count(*) from clinical_core.sync_outbound_events e where e.connection_id=_c.id and e.state='dead_letter'),
      'inboundPendingReview',(select count(*) from clinical_core.sync_inbound_events e where e.connection_id=_c.id and e.state='review_pending'),
      'openConflicts',(select count(*) from clinical_core.sync_conflicts c where c.connection_id=_c.id and c.state='open')),
    'lastSuccessfulSyncAt',(select max(e.delivered_at) from clinical_core.sync_outbound_events e where e.connection_id=_c.id),
    'resources',_resources,'outbound',_outbound,'inbound',_inbound,'conflicts',_conflicts,
    'deliveryEnabled',false,'generatedAt',clock_timestamp());
end $$;

create or replace function clinical_core.get_org_sync_operations(_organization_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _p clinical_core.sync_providers%rowtype;
begin
  perform clinical_private.assert_production_context(_organization_id,'clinical_data','workforce');
  if not clinical_private.has_clinical_role(_organization_id) then raise exception using errcode='42501',message='clinical_role_required'; end if;
  select * into _p from clinical_core.sync_providers p where p.organization_id=_organization_id
    and p.stable_id='alp_patient_sync' order by p.created_at desc limit 1;
  return jsonb_build_object('providerConfigured',coalesce(_p.state='active',false),
    'provider',case when _p.id is null then null else _p.stable_id end,
    'posture',case when _p.state='active' then 'approved' else 'disabled' end,
    'deliveryEnabled',false,
    'connections',jsonb_build_object(
      'verified',(select count(*) from clinical_core.patient_connections c where c.organization_id=_organization_id and c.state='verified'),
      'invitationPending',(select count(*) from clinical_core.patient_connections c where c.organization_id=_organization_id and c.state='invitation_pending'),
      'paused',(select count(*) from clinical_core.patient_connections c where c.organization_id=_organization_id and c.state='paused'),
      'revoked',(select count(*) from clinical_core.patient_connections c where c.organization_id=_organization_id and c.state='revoked')),
    'outbound',jsonb_build_object(
      'queued',(select count(*) from clinical_core.sync_outbound_events e where e.organization_id=_organization_id and e.state='queued'),
      'sending',(select count(*) from clinical_core.sync_outbound_events e where e.organization_id=_organization_id and e.state='delivering'),
      'failed',(select count(*) from clinical_core.sync_outbound_events e where e.organization_id=_organization_id and e.state='failed'),
      'deadLetter',(select count(*) from clinical_core.sync_outbound_events e where e.organization_id=_organization_id and e.state='dead_letter'),
      'delivered',(select count(*) from clinical_core.sync_outbound_events e where e.organization_id=_organization_id and e.state='delivered')),
    'inbound',jsonb_build_object(
      'pendingReview',(select count(*) from clinical_core.sync_inbound_events e where e.organization_id=_organization_id and e.state='review_pending'),
      'processed',(select count(*) from clinical_core.sync_inbound_events e where e.organization_id=_organization_id and e.state in ('accepted','rejected')),
      'conflicts',(select count(*) from clinical_core.sync_conflicts c where c.organization_id=_organization_id and c.state='open')),
    'maxQueueAgeSeconds',coalesce((select extract(epoch from clock_timestamp()-min(e.created_at))::integer
      from clinical_core.sync_outbound_events e where e.organization_id=_organization_id and e.state='queued'),0),
    'lastWorkerCycle',null,'circuit',null,'deadLetters','[]'::jsonb,'generatedAt',clock_timestamp());
end $$;

revoke all on function clinical_core.queue_sync_export(uuid,text,uuid) from public;
revoke all on function clinical_core.withdraw_sync_resource(uuid,text,uuid,text) from public;
revoke all on function clinical_core.retry_sync_event(uuid,text) from public;
revoke all on function clinical_core.cancel_sync_event(uuid,text) from public;
revoke all on function clinical_core.review_sync_inbound(uuid,text,text) from public;
revoke all on function clinical_core.record_sync_inbound_correction(uuid,jsonb,text) from public;
revoke all on function clinical_core.resolve_sync_conflict(uuid,text,text,integer) from public;
grant execute on function clinical_core.queue_sync_export(uuid,text,uuid) to clinical_core_api;
grant execute on function clinical_core.withdraw_sync_resource(uuid,text,uuid,text) to clinical_core_api;
grant execute on function clinical_core.retry_sync_event(uuid,text) to clinical_core_api;
grant execute on function clinical_core.cancel_sync_event(uuid,text) to clinical_core_api;
grant execute on function clinical_core.review_sync_inbound(uuid,text,text) to clinical_core_api;
grant execute on function clinical_core.record_sync_inbound_correction(uuid,jsonb,text) to clinical_core_api;
grant execute on function clinical_core.resolve_sync_conflict(uuid,text,text,integer) to clinical_core_api;
