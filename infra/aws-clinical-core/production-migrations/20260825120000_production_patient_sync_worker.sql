-- AWS-native patient-sync delivery and inbound materialization boundary.
-- This migration seeds no rows, approves no provider, and starts no worker.

do $$ begin
  if not exists(select 1 from pg_roles where rolname='clinical_sync_worker') then
    create role clinical_sync_worker nologin noinherit;
  end if;
  execute format('grant clinical_sync_worker to %I',current_user);
end $$;
grant usage on schema clinical_core,clinical_private to clinical_sync_worker;

alter table clinical_core.sync_providers add column version integer not null default 1 check(version>0);
alter table clinical_core.sync_providers add column updated_at timestamptz not null default clock_timestamp();
alter table clinical_core.sync_outbound_events add column lease_id uuid;
alter table clinical_core.sync_outbound_events add column lease_expires_at timestamptz;
alter table clinical_core.sync_outbound_events add column claimed_at timestamptz;
alter table clinical_core.sync_outbound_events add column claimed_by_worker_id uuid;
alter table clinical_core.sync_outbound_events add column next_attempt_at timestamptz;
alter table clinical_core.sync_outbound_events add constraint sync_outbound_lease_coherent check(
  (state='delivering' and lease_id is not null and lease_expires_at is not null and claimed_at is not null
    and claimed_by_worker_id is not null)
  or (state<>'delivering' and lease_id is null and lease_expires_at is null and claimed_by_worker_id is null));
create index sync_outbound_claim_idx on clinical_core.sync_outbound_events(provider_id,next_attempt_at,created_at)
  where state in ('queued','failed');

create table clinical_core.sync_delivery_attempts(
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null references clinical_core.patient_records(id),
  outbound_event_id uuid not null references clinical_core.sync_outbound_events(id),
  attempt_number integer not null check(attempt_number between 1 and 100),
  lease_id uuid not null unique,
  worker_id uuid not null,
  state text not null default 'claimed' check(state in ('claimed','delivered','acknowledged','failed','dead_letter','cancelled')),
  error_code_safe text check(error_code_safe is null or error_code_safe ~ '^[a-z0-9_]{1,64}$'),
  claimed_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  unique(outbound_event_id,attempt_number)
);
create index sync_delivery_attempts_event_idx on clinical_core.sync_delivery_attempts(outbound_event_id,attempt_number desc);

create table clinical_core.sync_delivery_events(
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null references clinical_core.patient_records(id),
  outbound_event_id uuid not null references clinical_core.sync_outbound_events(id),
  provider_id uuid not null references clinical_core.sync_providers(id),
  provider_event_id text not null check(provider_event_id ~ '^[A-Za-z0-9:._-]{8,200}$'),
  kind text not null check(kind in ('delivered','acknowledged','failed','rejected')),
  occurred_at timestamptz not null,
  signature_key_id text check(signature_key_id is null or signature_key_id ~ '^[A-Za-z0-9._-]{8,80}$'),
  error_code_safe text check(error_code_safe is null or error_code_safe ~ '^[a-z0-9_]{1,64}$'),
  recorded_at timestamptz not null default clock_timestamp(),
  unique(provider_id,provider_event_id)
);
create index sync_delivery_events_event_idx on clinical_core.sync_delivery_events(outbound_event_id,recorded_at);

create table clinical_core.sync_worker_cycles(
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  provider_id uuid not null references clinical_core.sync_providers(id),
  worker_id uuid not null,
  started_at timestamptz not null,
  completed_at timestamptz not null default clock_timestamp(),
  claimed integer not null check(claimed between 0 and 1000),
  succeeded integer not null check(succeeded between 0 and 1000),
  retried integer not null check(retried between 0 and 1000),
  dead_lettered integer not null check(dead_lettered between 0 and 1000),
  cancelled integer not null check(cancelled between 0 and 1000),
  lease_reclaims integer not null check(lease_reclaims between 0 and 1000),
  circuit_state text not null check(circuit_state in ('closed','open','half_open')),
  error_class text check(error_class is null or error_class in ('retryable','permanent','contract','security','consent')),
  max_queue_age_seconds integer not null check(max_queue_age_seconds between 0 and 31536000)
);
create index sync_worker_cycles_org_idx on clinical_core.sync_worker_cycles(organization_id,completed_at desc);

create table clinical_core.sync_circuit_states(
  provider_id uuid primary key references clinical_core.sync_providers(id),
  organization_id uuid not null references clinical_core.organizations(id),
  state text not null check(state in ('closed','open','half_open')),
  failure_count integer not null default 0 check(failure_count between 0 and 1000000),
  updated_at timestamptz not null default clock_timestamp()
);

create table clinical_core.sync_callback_nonces(
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  provider_id uuid not null references clinical_core.sync_providers(id),
  nonce text not null check(nonce ~ '^[A-Za-z0-9_-]{16,160}$'),
  seen_at timestamptz not null default clock_timestamp(),
  unique(provider_id,nonce)
);
create index sync_callback_nonces_seen_idx on clinical_core.sync_callback_nonces(seen_at);

create table clinical_core.sync_inbound_lab_imports(
  inbound_event_id uuid not null references clinical_core.sync_inbound_events(id),
  lab_import_event_id uuid not null unique references clinical_core.lab_import_events(id),
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null references clinical_core.patient_records(id),
  created_at timestamptz not null default clock_timestamp(),
  primary key(inbound_event_id,lab_import_event_id)
);

alter table clinical_core.sync_delivery_attempts enable row level security;
alter table clinical_core.sync_delivery_events enable row level security;
alter table clinical_core.sync_worker_cycles enable row level security;
alter table clinical_core.sync_circuit_states enable row level security;
alter table clinical_core.sync_callback_nonces enable row level security;
alter table clinical_core.sync_inbound_lab_imports enable row level security;
revoke all on clinical_core.sync_delivery_attempts,clinical_core.sync_delivery_events,
  clinical_core.sync_worker_cycles,clinical_core.sync_circuit_states,clinical_core.sync_callback_nonces,
  clinical_core.sync_inbound_lab_imports from public,clinical_core_api,clinical_sync_worker;

create or replace function clinical_private.assert_sync_worker_role()
returns void language plpgsql security invoker set search_path='' as $$
begin
  if current_setting('role',true)<>'clinical_sync_worker' then
    raise exception using errcode='42501',message='sync_worker_role_required';
  end if;
end $$;
revoke all on function clinical_private.assert_sync_worker_role() from public,clinical_core_api;
grant execute on function clinical_private.assert_sync_worker_role() to clinical_sync_worker;

create or replace function clinical_private.protect_sync_delivery_identity()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if new.organization_id<>old.organization_id or new.patient_record_id<>old.patient_record_id
    or new.outbound_event_id<>old.outbound_event_id or new.attempt_number<>old.attempt_number
    or new.lease_id<>old.lease_id or new.worker_id<>old.worker_id or new.claimed_at<>old.claimed_at then
    raise exception using errcode='55000',message='sync_delivery_identity_immutable';
  end if;
  return new;
end $$;
create trigger sync_delivery_attempt_identity_immutable before update on clinical_core.sync_delivery_attempts
  for each row execute function clinical_private.protect_sync_delivery_identity();
create trigger sync_delivery_events_append_only before update or delete on clinical_core.sync_delivery_events
  for each row execute function clinical_private.protect_sync_append_only();
create trigger sync_worker_cycles_append_only before update or delete on clinical_core.sync_worker_cycles
  for each row execute function clinical_private.protect_sync_append_only();
create trigger sync_callback_nonces_append_only before update on clinical_core.sync_callback_nonces
  for each row execute function clinical_private.protect_sync_append_only();
create trigger sync_inbound_lab_imports_append_only before update or delete on clinical_core.sync_inbound_lab_imports
  for each row execute function clinical_private.protect_sync_append_only();

alter table clinical_audit.events drop constraint events_action_check;
alter table clinical_audit.events add constraint events_action_check check(action in(
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
  'sync.inbound_accepted','sync.inbound_rejected','sync.inbound_correction_recorded','sync.conflict_resolved',
  'sync.provider_registered','sync.provider_reviewed'));
alter table clinical_audit.events drop constraint events_resource_type_check;
alter table clinical_audit.events add constraint events_resource_type_check check(resource_type in(
  'connection','consent','lab_import','clinical_record','privacy_request','patient_profile','lab_observation',
  'biomarker_observation','lab_document','report','audit_log','organization_membership','review_queue_item',
  'appointment','encounter','clinical_note','patient_protocol','patient_protocol_version',
  'sync_outbound_event','sync_inbound_event','sync_inbound_correction','sync_conflict','sync_provider'));

create or replace function clinical_core.register_sync_provider(_organization_id uuid,_adapter_version text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _provider clinical_core.sync_providers%rowtype; _actor uuid:=clinical_private.actor_person_id();
begin
  perform clinical_private.assert_production_context(_organization_id,'clinical_data','workforce');
  if not exists(select 1 from clinical_core.organization_memberships m where m.organization_id=_organization_id
      and m.person_id=_actor and m.status='active' and m.role in('owner','admin'))
    or char_length(btrim(coalesce(_adapter_version,''))) not between 1 and 64 then
    raise exception using errcode='42501',message='clinical_role_required'; end if;
  insert into clinical_core.sync_providers(organization_id,stable_id,contract_version,lab_contract_version,
    adapter_version,state) values(_organization_id,'alp_patient_sync','patient-sync/1','lab-result/1',
    btrim(_adapter_version),'pending_review') on conflict(organization_id,stable_id) do update set
    adapter_version=excluded.adapter_version,state='pending_review',reviewed_by_person_id=null,reviewed_at=null,
    version=clinical_core.sync_providers.version+1,updated_at=clock_timestamp() returning * into _provider;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,purpose,
    safe_metadata) values(_organization_id,_actor,'sync.provider_registered','sync_provider',_provider.id,
    'clinical_data',jsonb_build_object('state','pending_review','version',_provider.version));
  return jsonb_build_object('providerId',_provider.id,'stableId',_provider.stable_id,'state',_provider.state,
    'version',_provider.version,'deliveryEnabled',false);
end $$;

create or replace function clinical_core.review_sync_provider(_provider_id uuid,_decision text,_expected_version integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _provider clinical_core.sync_providers%rowtype; _actor uuid:=clinical_private.actor_person_id(); _state text;
begin
  select * into _provider from clinical_core.sync_providers where id=_provider_id for update;
  if not found then raise exception using errcode='P0002',message='sync_provider_not_found'; end if;
  perform clinical_private.assert_production_context(_provider.organization_id,'clinical_data','workforce');
  if not exists(select 1 from clinical_core.organization_memberships m where m.organization_id=_provider.organization_id
      and m.person_id=_actor and m.status='active' and m.role in('owner','admin')) then
    raise exception using errcode='42501',message='organization_admin_required'; end if;
  if _provider.version<>_expected_version then raise exception using errcode='40001',message='provider_version_conflict'; end if;
  if _decision not in('approve','suspend','retire') then raise exception using errcode='22023',message='provider_decision_invalid'; end if;
  _state:=case _decision when 'approve' then 'active' when 'suspend' then 'suspended' else 'retired' end;
  update clinical_core.sync_providers set state=_state,reviewed_by_person_id=_actor,reviewed_at=clock_timestamp(),
    version=version+1,updated_at=clock_timestamp() where id=_provider.id returning * into _provider;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,purpose,
    safe_metadata) values(_provider.organization_id,_actor,'sync.provider_reviewed','sync_provider',_provider.id,
    'clinical_data',jsonb_build_object('state',_provider.state,'version',_provider.version));
  return jsonb_build_object('providerId',_provider.id,'state',_provider.state,'version',_provider.version,
    'deliveryEnabled',false);
end $$;

create or replace function clinical_core.claim_sync_outbound(
  _organization_id uuid,_limit integer default 10,_lease_seconds integer default 120,_worker_id uuid default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare _provider uuid; _reclaims integer:=0; _events jsonb; _now timestamptz:=clock_timestamp();
begin
  perform clinical_private.assert_sync_worker_role();
  if _limit not between 1 and 100 or _lease_seconds not between 30 and 900 or _worker_id is null then
    raise exception using errcode='22023',message='sync_claim_invalid'; end if;
  select id into _provider from clinical_core.sync_providers where organization_id=_organization_id
    and stable_id='alp_patient_sync' and state='active';
  if _provider is null then return jsonb_build_object('events','[]'::jsonb,'leaseReclaims',0,'maxQueueAgeSeconds',0); end if;
  with reclaimed as(update clinical_core.sync_outbound_events set state='failed',lease_id=null,lease_expires_at=null,
    claimed_by_worker_id=null,error_code_safe='lease_expired',next_attempt_at=_now,updated_at=_now
    where provider_id=_provider and state='delivering' and lease_expires_at<_now returning id)
  select count(*) into _reclaims from reclaimed;
  with candidates as(
    select e.id from clinical_core.sync_outbound_events e join clinical_core.patient_connections c on c.id=e.connection_id
    where e.provider_id=_provider and e.state in('queued','failed') and coalesce(e.next_attempt_at,_now)<=_now
      and e.attempt_count<10 and c.state='verified' and exists(select 1 from clinical_core.current_consent s
        where s.connection_id=e.connection_id and s.scope=e.consent_scope and s.status='granted')
    order by e.created_at for update of e skip locked limit _limit),
  claimed as(update clinical_core.sync_outbound_events e set state='delivering',attempt_count=e.attempt_count+1,
    lease_id=gen_random_uuid(),lease_expires_at=_now+make_interval(secs=>_lease_seconds),claimed_at=_now,
    claimed_by_worker_id=_worker_id,error_code_safe=null,updated_at=_now from candidates c where e.id=c.id returning e.*),
  attempts as(insert into clinical_core.sync_delivery_attempts(organization_id,patient_record_id,outbound_event_id,
    attempt_number,lease_id,worker_id,claimed_at) select organization_id,patient_record_id,id,attempt_count,lease_id,
    _worker_id,_now from claimed returning id)
  select coalesce(jsonb_agg(jsonb_build_object('eventId',c.id,'eventUid',c.id,'contractVersion','patient-sync/1',
    'organizationId',c.organization_id,'connectionId',c.connection_id,'idempotencyKey',c.idempotency_key,
    'scope',c.consent_scope,'resourceType',c.resource_type,'resourceId',c.resource_id,
    'resourceVersion',c.resource_version,'occurredAt',c.created_at,'producer','ai_desktop_pro',
    'provenance',jsonb_build_object('sourceSystem','ai_desktop_pro','payloadSha256',c.payload_sha256,
      'generation',c.generation),'payload',c.payload,'payloadHash',c.payload_sha256,'attempts',c.attempt_count,
    'leaseExpiresAt',c.lease_expires_at) order by c.created_at),'[]'::jsonb) into _events from claimed c;
  return jsonb_build_object('events',_events,'leaseReclaims',_reclaims,'maxQueueAgeSeconds',coalesce((select
    extract(epoch from _now-min(created_at))::int from clinical_core.sync_outbound_events where provider_id=_provider
      and state in('queued','failed')),0));
end $$;

create or replace function clinical_core.recheck_sync_export(_event_uid uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _e clinical_core.sync_outbound_events%rowtype; _reason text;
begin
  perform clinical_private.assert_sync_worker_role();
  select * into _e from clinical_core.sync_outbound_events where id=_event_uid for update;
  if not found then raise exception using errcode='P0002',message='sync_event_not_found'; end if;
  if _e.state<>'delivering' or _e.lease_expires_at<=clock_timestamp() then _reason:='lease_invalid';
  elsif not exists(select 1 from clinical_core.sync_providers where id=_e.provider_id and state='active') then _reason:='provider_inactive';
  elsif not exists(select 1 from clinical_core.patient_connections where id=_e.connection_id and state='verified') then _reason:='connection_inactive';
  elsif not exists(select 1 from clinical_core.current_consent where connection_id=_e.connection_id
    and scope=_e.consent_scope and status='granted') then _reason:='consent_revoked'; end if;
  if _reason is not null then
    update clinical_core.sync_outbound_events set state='cancelled',lease_id=null,lease_expires_at=null,
      claimed_by_worker_id=null,cancelled_at=clock_timestamp(),error_code_safe=_reason,updated_at=clock_timestamp() where id=_e.id;
    update clinical_core.sync_delivery_attempts set state='cancelled',error_code_safe=_reason,completed_at=clock_timestamp()
      where lease_id=_e.lease_id and state='claimed';
    return jsonb_build_object('deliverable',false,'reason',_reason); end if;
  return jsonb_build_object('deliverable',true,'reason',null);
end $$;

create or replace function clinical_core.record_sync_delivery(_event_uid uuid,_provider_event_id text,_kind text,
  _occurred_at timestamptz,_error_safe text default null,_signature_key_id text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _e clinical_core.sync_outbound_events%rowtype; _duplicate boolean:=false; _code text; _next text;
begin
  perform clinical_private.assert_sync_worker_role();
  if _kind not in('delivered','acknowledged','failed','rejected') or _occurred_at>clock_timestamp()+interval '5 minutes'
    or _provider_event_id!~'^[A-Za-z0-9:._-]{8,200}$' then raise exception using errcode='22023',message='delivery_evidence_invalid'; end if;
  select * into _e from clinical_core.sync_outbound_events where id=_event_uid for update;
  if not found then raise exception using errcode='P0002',message='sync_event_not_found'; end if;
  _code:=case when _error_safe is null then null else lower(regexp_replace(_error_safe,'[^a-zA-Z0-9_]+','_','g')) end;
  _code:=nullif(left(trim(both '_' from coalesce(_code,'')),64),'');
  begin
    insert into clinical_core.sync_delivery_events(organization_id,patient_record_id,outbound_event_id,provider_id,
      provider_event_id,kind,occurred_at,signature_key_id,error_code_safe) values(_e.organization_id,
      _e.patient_record_id,_e.id,_e.provider_id,_provider_event_id,_kind,_occurred_at,_signature_key_id,_code);
  exception when unique_violation then _duplicate:=true; end;
  if _duplicate then return jsonb_build_object('ok',true,'duplicate',true,'state',_e.state); end if;
  _next:=case when _kind in('delivered','acknowledged') then 'delivered'
    when _kind='rejected' or _e.attempt_count>=10 then 'dead_letter' else 'failed' end;
  update clinical_core.sync_outbound_events set state=_next,delivered_at=case when _next='delivered' then _occurred_at else delivered_at end,
    error_code_safe=case when _next in('failed','dead_letter') then coalesce(_code,'provider_failure') else null end,
    next_attempt_at=case when _next='failed' then clock_timestamp()+make_interval(secs=>least(3600,30*(2^least(_e.attempt_count,7)))) else null end,
    lease_id=null,lease_expires_at=null,claimed_by_worker_id=null,updated_at=clock_timestamp() where id=_e.id;
  update clinical_core.sync_delivery_attempts set state=case when _kind='rejected' then 'dead_letter' else _kind end,
    error_code_safe=_code,completed_at=clock_timestamp() where lease_id=_e.lease_id and state='claimed';
  if _next='dead_letter' then insert into clinical_core.sync_dead_letters(organization_id,patient_record_id,outbound_event_id,error_code_safe)
    values(_e.organization_id,_e.patient_record_id,_e.id,coalesce(_code,'provider_rejected')) on conflict(outbound_event_id) do nothing; end if;
  if _kind='acknowledged' then update clinical_core.sync_resource_acks set state='acknowledged',updated_at=clock_timestamp()
    where last_outbound_event_id=_e.id; end if;
  return jsonb_build_object('ok',true,'duplicate',false,'state',_next);
end $$;

create or replace function clinical_core.register_sync_callback_nonce(_organization_id uuid,_provider text,_nonce text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _provider_id uuid; _replay boolean:=false;
begin
  perform clinical_private.assert_sync_worker_role();
  select id into _provider_id from clinical_core.sync_providers where organization_id=_organization_id
    and stable_id=_provider and state='active';
  if _provider_id is null or _nonce!~'^[A-Za-z0-9_-]{16,160}$' then raise exception using errcode='42501',message='callback_refused'; end if;
  begin insert into clinical_core.sync_callback_nonces(organization_id,provider_id,nonce)
    values(_organization_id,_provider_id,_nonce); exception when unique_violation then _replay:=true; end;
  delete from clinical_core.sync_callback_nonces where seen_at<clock_timestamp()-interval '7 days';
  return jsonb_build_object('ok',true,'replay',_replay);
end $$;

create or replace function clinical_private.sync_inbound_scope(_resource_type text)
returns text language sql immutable security invoker set search_path='' as $$ select case _resource_type
  when 'lab_result' then 'lab_results_import' when 'patient_message' then 'messaging'
  when 'symptom_checkin' then 'symptoms_adherence' when 'adherence_checkin' then 'symptoms_adherence' end $$;

create or replace function clinical_core.record_sync_inbound(_connection_id uuid,_provider_event_id text,
  _contract_version text,_resource_type text,_payload jsonb,_payload_hash text,_occurred_at timestamptz,
  _external_resource_id text default null,_resource_version text default null,_signature_key_id text default null,
  _correlation_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _c clinical_core.patient_connections%rowtype; _p clinical_core.sync_providers%rowtype;
  _existing clinical_core.sync_inbound_events%rowtype; _id uuid; _scope text;
begin
  perform clinical_private.assert_sync_worker_role();
  select * into _c from clinical_core.patient_connections where id=_connection_id and state='verified';
  if not found then raise exception using errcode='42501',message='verified_connection_required'; end if;
  select * into _p from clinical_core.sync_providers where organization_id=_c.organization_id
    and stable_id='alp_patient_sync' and state='active' and contract_version='patient-sync/1';
  _scope:=clinical_private.sync_inbound_scope(_resource_type);
  if _p.id is null or _contract_version<>'patient-sync/1' or _scope is null
    or _resource_type='lab_result' or jsonb_typeof(_payload)<>'object' or octet_length(_payload::text) not between 2 and 16384
    or _payload ?| array['authorization','cookie','password','access_token','refresh_token','service_role_key','secret','ssn','social_security_number','email','phone','date_of_birth']
    or _payload_hash!~'^[0-9a-f]{64}$' or _occurred_at not between clock_timestamp()-interval '30 days' and clock_timestamp()+interval '5 minutes'
    or coalesce(_resource_version,'')!~'^[A-Za-z0-9._:-]{1,64}$' then
    raise exception using errcode='22023',message='sync_inbound_invalid'; end if;
  if not exists(select 1 from clinical_core.current_consent where connection_id=_c.id and scope=_scope and status='granted') then
    raise exception using errcode='42501',message='consent_required'; end if;
  select * into _existing from clinical_core.sync_inbound_events where provider_id=_p.id and provider_event_id=_provider_event_id;
  if found then
    if _existing.payload_sha256<>_payload_hash then raise exception using errcode='40001',message='provider_event_conflict'; end if;
    return jsonb_build_object('ok',true,'duplicate',true,'state',_existing.state,'eventId',_existing.id); end if;
  insert into clinical_core.sync_inbound_events(organization_id,patient_record_id,connection_id,provider_id,
    provider_event_id,resource_type,resource_version,payload,payload_sha256) values(_c.organization_id,
    _c.patient_record_id,_c.id,_p.id,_provider_event_id,_resource_type,_resource_version,_payload,_payload_hash)
    returning id into _id;
  insert into clinical_core.review_queue_items(organization_id,patient_record_id,item_type,reference_id,title,
    priority,created_by_person_id,updated_by_person_id) values(_c.organization_id,_c.patient_record_id,
    'sync_inbound',_id,case when _resource_type='patient_message' then 'Patient app message' else 'Patient app check-in' end,
    'medium',_c.consumer_person_id,_c.consumer_person_id);
  return jsonb_build_object('ok',true,'duplicate',false,'state','review_pending','eventId',_id,'chartMaterialized',false);
end $$;

create or replace function clinical_core.record_sync_lab_result(_connection_id uuid,_provider_event_id text,
  _contract_version text,_resource_type text,_payload jsonb,_payload_hash text,_occurred_at timestamptz,
  _external_resource_id text default null,_resource_version text default null,_signature_key_id text default null,
  _correlation_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _c clinical_core.patient_connections%rowtype; _p clinical_core.sync_providers%rowtype;
  _existing clinical_core.sync_inbound_events%rowtype; _inbound uuid; _lab uuid; _marker jsonb; _marker_event text;
  _collected timestamptz; _panel_id text; _panel_name text; _count integer:=0;
begin
  perform clinical_private.assert_sync_worker_role();
  select * into _c from clinical_core.patient_connections where id=_connection_id and state='verified';
  if not found then raise exception using errcode='42501',message='verified_connection_required'; end if;
  select * into _p from clinical_core.sync_providers where organization_id=_c.organization_id
    and stable_id='alp_patient_sync' and state='active' and contract_version='patient-sync/1'
    and lab_contract_version='lab-result/1';
  if _p.id is null or _contract_version<>'lab-result/1' or _resource_type<>'lab_result'
    or _payload_hash!~'^[0-9a-f]{64}$' or jsonb_typeof(_payload)<>'object'
    or _payload ?| array['authorization','cookie','password','access_token','refresh_token','service_role_key','secret','ssn','social_security_number','email','phone','date_of_birth']
    or jsonb_typeof(_payload->'markers')<>'array' or jsonb_array_length(_payload->'markers') not between 1 and 250
    or _occurred_at not between clock_timestamp()-interval '30 days' and clock_timestamp()+interval '5 minutes'
    or coalesce(_resource_version,'')!~'^[A-Za-z0-9._:-]{1,64}$' then
    raise exception using errcode='22023',message='lab_result_invalid'; end if;
  if not exists(select 1 from clinical_core.current_consent where connection_id=_c.id and scope='lab_results_import' and status='granted') then
    raise exception using errcode='42501',message='lab_import_consent_required'; end if;
  select * into _existing from clinical_core.sync_inbound_events where provider_id=_p.id and provider_event_id=_provider_event_id;
  if found then
    if _existing.payload_sha256<>_payload_hash then raise exception using errcode='40001',message='provider_event_conflict'; end if;
    return jsonb_build_object('ok',true,'duplicate',true,'state',_existing.state,'eventId',_existing.id); end if;
  _panel_id:=coalesce(_external_resource_id,_payload->>'panelId'); _panel_name:=_payload->>'panelName';
  begin _collected:=(_payload->>'collectedAt')::timestamptz; exception when others then raise exception using errcode='22023',message='lab_result_invalid'; end;
  if coalesce(_panel_id,'')!~'^[A-Za-z0-9:_-]{1,160}$' or char_length(coalesce(_panel_name,'')) not between 1 and 200
    or _collected>_occurred_at+interval '1 day' then raise exception using errcode='22023',message='lab_result_invalid'; end if;
  insert into clinical_core.sync_inbound_events(organization_id,patient_record_id,connection_id,provider_id,
    provider_event_id,resource_type,resource_version,payload,payload_sha256) values(_c.organization_id,
    _c.patient_record_id,_c.id,_p.id,_provider_event_id,'lab_result',_resource_version,_payload,_payload_hash) returning id into _inbound;
  for _marker in select value from jsonb_array_elements(_payload->'markers') loop
    _count:=_count+1; _marker_event:=left(_provider_event_id,100)||':'||left(coalesce(_marker->>'markerId',_count::text),50);
    if coalesce(_marker->>'markerId','')!~'^[A-Za-z0-9:_-]{1,160}$'
      or char_length(coalesce(_marker->>'markerName','')) not between 1 and 200
      or jsonb_typeof(_marker->'value')<>'number' then raise exception using errcode='22023',message='lab_marker_invalid'; end if;
    insert into clinical_core.lab_import_events(organization_id,patient_record_id,connection_id,provider_id,
      provider_event_id,external_panel_id,external_marker_id,resource_version,panel_name,source_label,marker_name,
      value_numeric,unit,reference_min,reference_max,source_status,collected_at,occurred_at,payload_sha256,state)
    values(_c.organization_id,_c.patient_record_id,_c.id,_p.id,_marker_event,_panel_id,_marker->>'markerId',
      _resource_version,_panel_name,nullif(_payload->>'sourceLabel',''),_marker->>'markerName',
      (_marker->>'value')::numeric,nullif(_marker->>'unit',''),nullif(_marker->>'referenceMin','')::numeric,
      nullif(_marker->>'referenceMax','')::numeric,nullif(_marker->>'sourceStatus',''),_collected,_occurred_at,
      _payload_hash,'review_pending') returning id into _lab;
    insert into clinical_core.sync_inbound_lab_imports(inbound_event_id,lab_import_event_id,organization_id,patient_record_id)
      values(_inbound,_lab,_c.organization_id,_c.patient_record_id);
  end loop;
  insert into clinical_core.review_queue_items(organization_id,patient_record_id,item_type,reference_id,title,
    priority,created_by_person_id,updated_by_person_id) values(_c.organization_id,_c.patient_record_id,
    'sync_inbound',_inbound,'Patient app lab panel','high',_c.consumer_person_id,_c.consumer_person_id);
  return jsonb_build_object('ok',true,'duplicate',false,'state','review_pending','eventId',_inbound,
    'markerCount',_count,'chartMaterialized',false);
end $$;

create or replace function clinical_core.review_sync_inbound(_event_id uuid,_action text,_note text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _e clinical_core.sync_inbound_events%rowtype; _actor uuid:=clinical_private.actor_person_id();
  _state text; _link record; _materialized integer:=0; _c clinical_core.patient_connections%rowtype; _collection text;
begin
  select * into _e from clinical_core.sync_inbound_events where id=_event_id for update;
  if not found then raise exception using errcode='P0002',message='inbound_event_not_found'; end if;
  perform clinical_private.assert_production_context(_e.organization_id,'clinical_data','workforce');
  if not clinical_private.has_clinical_role(_e.organization_id) then raise exception using errcode='42501',message='clinical_role_required'; end if;
  if _action not in('accept','reject') or (_action='reject' and char_length(btrim(coalesce(_note,'')))<1)
    then raise exception using errcode='22023',message='review_decision_invalid'; end if;
  _state:=case _action when 'accept' then 'accepted' else 'rejected' end;
  if _e.state in('accepted','rejected') then return jsonb_build_object('eventId',_e.id,'state',_e.state,
    'alreadyApplied',true,'chartMaterialized',_e.state='accepted'); end if;
  if _e.state='conflict' and _action='accept' and char_length(btrim(coalesce(_note,'')))<1 then
    raise exception using errcode='22023',message='conflict_acceptance_note_required'; end if;
  if _action='accept' and _e.resource_type='lab_result' then
    for _link in select l.* from clinical_core.lab_import_events l join clinical_core.sync_inbound_lab_imports x
      on x.lab_import_event_id=l.id where x.inbound_event_id=_e.id for update of l loop
      insert into clinical_core.lab_observations(organization_id,patient_record_id,import_event_id,panel_name,
        marker_name,value_numeric,unit,reference_min,reference_max,observed_at,provenance) values(
        _link.organization_id,_link.patient_record_id,_link.id,_link.panel_name,_link.marker_name,_link.value_numeric,
        _link.unit,_link.reference_min,_link.reference_max,_link.collected_at,jsonb_build_object(
          'sourceSystem','ai_longevity_pro_v2','providerEventId',_link.provider_event_id,
          'externalPanelId',_link.external_panel_id,'externalMarkerId',_link.external_marker_id,
          'resourceVersion',_link.resource_version,'payloadSha256',_link.payload_sha256,
          'acceptedBy',_actor,'acceptedAt',clock_timestamp())) on conflict(import_event_id) do nothing;
      get diagnostics _materialized=row_count;
      update clinical_core.lab_import_events set state='accepted',reviewed_at=clock_timestamp(),
        reviewed_by_person_id=_actor,review_note=nullif(left(btrim(coalesce(_note,'')),500),'') where id=_link.id;
    end loop;
  elsif _action='accept' and _e.resource_type<>'patient_message' then
    select * into _c from clinical_core.patient_connections where id=_e.connection_id;
    _collection:=case _e.resource_type when 'symptom_checkin' then 'symptom_logs'
      when 'adherence_checkin' then 'daily_adherence' else 'weekly_checkins' end;
    insert into clinical_core.consumer_clinical_record_versions(stable_record_id,organization_id,patient_record_id,
      connection_id,consumer_person_id,collection,record_key,resource_version,idempotency_key,payload,payload_sha256,deleted)
    values(_e.id,_e.organization_id,_e.patient_record_id,_e.connection_id,_c.consumer_person_id,_collection,
      _e.provider_event_id,_e.resource_version,'sync:'||_e.id::text,_e.payload,_e.payload_sha256,false)
    on conflict(connection_id,idempotency_key) do nothing; get diagnostics _materialized=row_count;
  end if;
  update clinical_core.sync_inbound_events set state=_state,reviewed_at=clock_timestamp(),reviewed_by_person_id=_actor where id=_e.id;
  update clinical_core.review_queue_items set status=case when _action='accept' then 'resolved' else 'dismissed' end,
    updated_by_person_id=_actor,updated_at=clock_timestamp() where reference_id=_e.id and item_type='sync_inbound'
    and status in('open','in_review','snoozed');
  if _action='reject' then update clinical_core.lab_import_events l set state='rejected',reviewed_at=clock_timestamp(),
    reviewed_by_person_id=_actor,review_note=left(btrim(_note),500) from clinical_core.sync_inbound_lab_imports x
    where x.inbound_event_id=_e.id and x.lab_import_event_id=l.id; end if;
  insert into clinical_audit.events(organization_id,actor_person_id,action,resource_type,resource_id,patient_record_id,
    purpose,safe_metadata) values(_e.organization_id,_actor,case when _action='accept' then 'sync.inbound_accepted'
    else 'sync.inbound_rejected' end,'sync_inbound_event',_e.id,_e.patient_record_id,'clinical_data',
    jsonb_build_object('resource_type',_e.resource_type,'reason_present',coalesce(char_length(btrim(_note)),0)>0,
      'chart_materialized',_action='accept'));
  return jsonb_build_object('eventId',_e.id,'state',_state,'alreadyApplied',false,
    'chartMaterialized',_action='accept' and _e.resource_type<>'patient_message','materializedCount',_materialized);
end $$;

create or replace function clinical_core.record_sync_worker_cycle(_organization_id uuid,_provider text,
  _started_at timestamptz,_claimed integer,_succeeded integer,_retried integer,_dead_lettered integer,
  _cancelled integer,_lease_reclaims integer,_circuit_state text,_error_class text,_max_queue_age_seconds integer,
  _worker_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _p uuid; _id uuid;
begin
  perform clinical_private.assert_sync_worker_role();
  select id into _p from clinical_core.sync_providers where organization_id=_organization_id and stable_id=_provider and state='active';
  if _p is null or _worker_id is null or _circuit_state not in('closed','open','half_open') then
    raise exception using errcode='22023',message='worker_cycle_invalid'; end if;
  insert into clinical_core.sync_worker_cycles(organization_id,provider_id,worker_id,started_at,claimed,succeeded,
    retried,dead_lettered,cancelled,lease_reclaims,circuit_state,error_class,max_queue_age_seconds) values(
    _organization_id,_p,_worker_id,_started_at,_claimed,_succeeded,_retried,_dead_lettered,_cancelled,
    _lease_reclaims,_circuit_state,_error_class,_max_queue_age_seconds) returning id into _id;
  insert into clinical_core.sync_circuit_states(provider_id,organization_id,state,failure_count) values(_p,_organization_id,
    _circuit_state,case when _error_class is null then 0 else 1 end) on conflict(provider_id) do update set state=excluded.state,
    failure_count=case when excluded.failure_count=0 then 0 else clinical_core.sync_circuit_states.failure_count+1 end,
    updated_at=clock_timestamp();
  return jsonb_build_object('ok',true,'cycleId',_id);
end $$;

create or replace function clinical_core.get_org_sync_operations(_organization_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _p clinical_core.sync_providers%rowtype;
begin
  perform clinical_private.assert_production_context(_organization_id,'clinical_data','workforce');
  if not clinical_private.has_clinical_role(_organization_id) then raise exception using errcode='42501',message='clinical_role_required'; end if;
  select * into _p from clinical_core.sync_providers where organization_id=_organization_id and stable_id='alp_patient_sync';
  return jsonb_build_object('providerConfigured',coalesce(_p.state='active',false),'provider',_p.stable_id,
    'posture',coalesce(_p.state,'disabled'),'deliveryEnabled',false,
    'connections',jsonb_build_object('verified',(select count(*) from clinical_core.patient_connections where organization_id=_organization_id and state='verified'),
      'invitationPending',(select count(*) from clinical_core.patient_connections where organization_id=_organization_id and state='invitation_pending'),
      'paused',(select count(*) from clinical_core.patient_connections where organization_id=_organization_id and state='paused'),
      'revoked',(select count(*) from clinical_core.patient_connections where organization_id=_organization_id and state='revoked')),
    'outbound',jsonb_build_object('queued',(select count(*) from clinical_core.sync_outbound_events where organization_id=_organization_id and state='queued'),
      'sending',(select count(*) from clinical_core.sync_outbound_events where organization_id=_organization_id and state='delivering'),
      'failed',(select count(*) from clinical_core.sync_outbound_events where organization_id=_organization_id and state='failed'),
      'deadLetter',(select count(*) from clinical_core.sync_outbound_events where organization_id=_organization_id and state='dead_letter'),
      'delivered',(select count(*) from clinical_core.sync_outbound_events where organization_id=_organization_id and state='delivered')),
    'inbound',jsonb_build_object('pendingReview',(select count(*) from clinical_core.sync_inbound_events where organization_id=_organization_id and state='review_pending'),
      'processed',(select count(*) from clinical_core.sync_inbound_events where organization_id=_organization_id and state in('accepted','rejected')),
      'conflicts',(select count(*) from clinical_core.sync_conflicts where organization_id=_organization_id and state='open')),
    'maxQueueAgeSeconds',coalesce((select extract(epoch from clock_timestamp()-min(created_at))::int from clinical_core.sync_outbound_events
      where organization_id=_organization_id and state in('queued','failed')),0),
    'lastWorkerCycle',(select jsonb_build_object('completedAt',completed_at,'claimed',claimed,'succeeded',succeeded,
      'retried',retried,'deadLettered',dead_lettered,'cancelled',cancelled,'leaseReclaims',lease_reclaims)
      from clinical_core.sync_worker_cycles where organization_id=_organization_id order by completed_at desc limit 1),
    'circuit',(select jsonb_build_object('state',state,'failureCount',failure_count,'updatedAt',updated_at)
      from clinical_core.sync_circuit_states where organization_id=_organization_id),'generatedAt',clock_timestamp());
end $$;

revoke all on function clinical_core.register_sync_provider(uuid,text),clinical_core.review_sync_provider(uuid,text,integer)
  from public,clinical_sync_worker;
grant execute on function clinical_core.register_sync_provider(uuid,text),clinical_core.review_sync_provider(uuid,text,integer)
  to clinical_core_api;
revoke all on function clinical_core.claim_sync_outbound(uuid,integer,integer,uuid),
  clinical_core.recheck_sync_export(uuid),clinical_core.record_sync_delivery(uuid,text,text,timestamptz,text,text),
  clinical_core.register_sync_callback_nonce(uuid,text,text),clinical_core.record_sync_inbound(uuid,text,text,text,jsonb,text,timestamptz,text,text,text,uuid),
  clinical_core.record_sync_lab_result(uuid,text,text,text,jsonb,text,timestamptz,text,text,text,uuid),
  clinical_core.record_sync_worker_cycle(uuid,text,timestamptz,integer,integer,integer,integer,integer,integer,text,text,integer,uuid)
  from public,clinical_core_api;
grant execute on function clinical_core.claim_sync_outbound(uuid,integer,integer,uuid),
  clinical_core.recheck_sync_export(uuid),clinical_core.record_sync_delivery(uuid,text,text,timestamptz,text,text),
  clinical_core.register_sync_callback_nonce(uuid,text,text),clinical_core.record_sync_inbound(uuid,text,text,text,jsonb,text,timestamptz,text,text,text,uuid),
  clinical_core.record_sync_lab_result(uuid,text,text,text,jsonb,text,timestamptz,text,text,text,uuid),
  clinical_core.record_sync_worker_cycle(uuid,text,timestamptz,integer,integer,integer,integer,integer,integer,text,text,integer,uuid)
  to clinical_sync_worker;
