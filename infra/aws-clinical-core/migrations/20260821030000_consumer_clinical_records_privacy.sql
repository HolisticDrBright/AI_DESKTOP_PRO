-- Governed, synthetic-only consumer clinical records and privacy requests.
-- Record versions and privacy requests are append-only. Clinical payloads never
-- enter the audit stream; audit metadata contains opaque identifiers only.

alter table clinical_audit.events drop constraint events_action_check;
alter table clinical_audit.events add constraint events_action_check check (action in (
  'connection.invitation_issued','connection.invitation_claimed',
  'consent.granted','consent.revoked','lab_import.received',
  'lab_import.duplicate','lab_import.accepted','lab_import.rejected',
  'clinical_record.received','clinical_record.duplicate','privacy_request.submitted'));
alter table clinical_audit.events drop constraint events_resource_type_check;
alter table clinical_audit.events add constraint events_resource_type_check
  check (resource_type in ('connection','consent','lab_import','clinical_record','privacy_request'));

create table clinical_core.consumer_clinical_record_versions (
  id uuid primary key default gen_random_uuid(),
  stable_record_id uuid not null,
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null references clinical_core.patient_records(id),
  connection_id uuid not null references clinical_core.patient_connections(id),
  consumer_person_id uuid not null references clinical_core.persons(id),
  collection text not null check (collection in (
    'protocols','daily_adherence','symptom_logs','hormone_entries',
    'meal_logs','subjective_rollups','weekly_checkins')),
  record_key text not null check (record_key ~ '^[A-Za-z0-9:_-]{1,160}$'),
  resource_version text not null check (resource_version ~ '^[A-Za-z0-9._:-]{1,64}$'),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9:_-]{8,160}$'),
  payload jsonb not null,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  deleted boolean not null default false,
  received_at timestamptz not null default clock_timestamp(),
  foreign key (connection_id, organization_id, patient_record_id)
    references clinical_core.patient_connections(id, organization_id, patient_record_id),
  check (jsonb_typeof(payload) = 'object'),
  check (octet_length(payload::text) between 2 and 16384),
  check (not (payload ?| array[
    'authorization','cookie','password','access_token','refresh_token',
    'service_role_key','secret','ssn','social_security_number','email','phone','date_of_birth'
  ])),
  unique (connection_id, collection, record_key, resource_version),
  unique (connection_id, idempotency_key)
);
create index consumer_clinical_record_current_idx
  on clinical_core.consumer_clinical_record_versions(
    connection_id, collection, record_key, received_at desc, id desc);
create index consumer_clinical_record_patient_idx
  on clinical_core.consumer_clinical_record_versions(
    patient_record_id, collection, received_at desc);

create table clinical_core.privacy_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null references clinical_core.patient_records(id),
  connection_id uuid not null references clinical_core.patient_connections(id),
  requested_by_person_id uuid not null references clinical_core.persons(id),
  kind text not null check (kind in ('export','correction','deletion')),
  status text not null default 'submitted'
    check (status in ('submitted','in_review','completed','rejected','cancelled')),
  detail text check (detail is null or char_length(detail) between 1 and 1000),
  submitted_at timestamptz not null default clock_timestamp(),
  resolved_at timestamptz,
  resolved_by_person_id uuid references clinical_core.persons(id),
  resolution_note text check (resolution_note is null or char_length(resolution_note) between 1 and 1000),
  foreign key (connection_id, organization_id, patient_record_id)
    references clinical_core.patient_connections(id, organization_id, patient_record_id),
  check ((status in ('submitted','in_review') and resolved_at is null and resolved_by_person_id is null)
    or (status in ('completed','rejected','cancelled') and resolved_at is not null))
);
create index privacy_requests_consumer_idx
  on clinical_core.privacy_requests(connection_id, submitted_at desc);
create index privacy_requests_workforce_idx
  on clinical_core.privacy_requests(organization_id, status, submitted_at);

create or replace function clinical_private.consumer_collection_scope(_collection text)
returns text language sql immutable set search_path = '' as $$
  select case _collection
    when 'protocols' then 'protocols_supplements'
    when 'daily_adherence' then 'symptoms_adherence'
    when 'symptom_logs' then 'symptoms_adherence'
    when 'hormone_entries' then 'forms_checkins'
    when 'meal_logs' then 'nutrition'
    when 'subjective_rollups' then 'symptoms_adherence'
    when 'weekly_checkins' then 'forms_checkins'
    else null end
$$;

create or replace function clinical_core.record_consumer_clinical_version(
  _connection_id uuid, _stable_record_id uuid, _collection text, _record_key text,
  _resource_version text, _idempotency_key text, _payload jsonb,
  _payload_sha256 text, _deleted boolean default false
)
returns table(version_id uuid, stable_record_id uuid, record_key text,
  resource_version text, received_at timestamptz, duplicate boolean)
language plpgsql security definer set search_path = '' as $$
declare
  _connection clinical_core.patient_connections%rowtype;
  _existing clinical_core.consumer_clinical_record_versions%rowtype;
  _inserted clinical_core.consumer_clinical_record_versions%rowtype;
  _required_scope text;
begin
  select * into _connection from clinical_core.patient_connections c
    where c.id = _connection_id and c.state = 'verified';
  if not found then raise exception using errcode = 'P0002', message = 'verified_connection_required'; end if;
  perform clinical_private.assert_synthetic_context(_connection.organization_id, 'clinical_data', 'consumer');
  if _connection.consumer_person_id <> clinical_private.actor_person_id() then
    raise exception using errcode = '42501', message = 'consumer_connection_refused';
  end if;
  _required_scope := clinical_private.consumer_collection_scope(_collection);
  if _required_scope is null then
    raise exception using errcode = '22023', message = 'clinical_collection_invalid';
  end if;
  if not exists (
    select 1 from clinical_core.current_consent c
    where c.connection_id = _connection_id and c.scope = _required_scope and c.status = 'granted'
  ) then raise exception using errcode = '42501', message = 'clinical_record_consent_required'; end if;
  if _payload_sha256 !~ '^[0-9a-f]{64}$' or jsonb_typeof(_payload) <> 'object'
    or octet_length(_payload::text) not between 2 and 16384 then
    raise exception using errcode = '22023', message = 'clinical_record_invalid';
  end if;

  select * into _existing from clinical_core.consumer_clinical_record_versions r
    where r.connection_id = _connection_id and r.idempotency_key = _idempotency_key;
  if found then
    if _existing.payload_sha256 <> _payload_sha256
      or _existing.collection <> _collection or _existing.record_key <> _record_key
      or _existing.resource_version <> _resource_version or _existing.deleted <> _deleted then
      raise exception using errcode = '40001', message = 'idempotency_conflict';
    end if;
    insert into clinical_audit.events(organization_id, actor_person_id, action,
      resource_type, resource_id, purpose, safe_metadata)
    values (_connection.organization_id, clinical_private.actor_person_id(),
      'clinical_record.duplicate', 'clinical_record', _existing.id, 'clinical_data',
      jsonb_build_object('collection',_collection));
    return query select _existing.id, _existing.stable_record_id, _existing.record_key,
      _existing.resource_version, _existing.received_at, true;
    return;
  end if;

  select * into _existing from clinical_core.consumer_clinical_record_versions r
    where r.connection_id = _connection_id and r.collection = _collection
      and r.record_key = _record_key and r.resource_version = _resource_version;
  if found then
    if _existing.payload_sha256 <> _payload_sha256 or _existing.deleted <> _deleted then
      raise exception using errcode = '40001', message = 'resource_version_conflict';
    end if;
    return query select _existing.id, _existing.stable_record_id, _existing.record_key,
      _existing.resource_version, _existing.received_at, true;
    return;
  end if;

  insert into clinical_core.consumer_clinical_record_versions(
    stable_record_id, organization_id, patient_record_id, connection_id,
    consumer_person_id, collection, record_key, resource_version,
    idempotency_key, payload, payload_sha256, deleted
  ) values (
    _stable_record_id, _connection.organization_id, _connection.patient_record_id,
    _connection.id, _connection.consumer_person_id, _collection, _record_key,
    _resource_version, _idempotency_key, _payload, _payload_sha256, _deleted
  ) returning * into _inserted;
  insert into clinical_audit.events(organization_id, actor_person_id, action,
    resource_type, resource_id, purpose, safe_metadata)
  values (_connection.organization_id, clinical_private.actor_person_id(),
    'clinical_record.received', 'clinical_record', _inserted.id, 'clinical_data',
    jsonb_build_object('collection',_collection,'deleted',_deleted));
  return query select _inserted.id, _inserted.stable_record_id, _inserted.record_key,
    _inserted.resource_version, _inserted.received_at, false;
end
$$;

create or replace function clinical_core.list_consumer_clinical_records(
  _connection_id uuid, _collection text, _after_received_at timestamptz default null,
  _after_id uuid default null, _limit integer default 100
)
returns table(version_id uuid, stable_record_id uuid, record_key text,
  resource_version text, payload jsonb, payload_sha256 text, deleted boolean,
  received_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare
  _connection clinical_core.patient_connections%rowtype;
  _required_scope text;
begin
  select * into _connection from clinical_core.patient_connections c
    where c.id = _connection_id and c.state in ('verified','paused');
  if not found then raise exception using errcode = 'P0002', message = 'connection_required'; end if;
  perform clinical_private.assert_synthetic_context(_connection.organization_id, 'clinical_data', 'consumer');
  if _connection.consumer_person_id <> clinical_private.actor_person_id() then
    raise exception using errcode = '42501', message = 'consumer_connection_refused';
  end if;
  _required_scope := clinical_private.consumer_collection_scope(_collection);
  if _required_scope is null or _limit not between 1 and 200 then
    raise exception using errcode = '22023', message = 'clinical_query_invalid';
  end if;
  if not exists (
    select 1 from clinical_core.current_consent c
    where c.connection_id = _connection_id and c.scope = _required_scope and c.status = 'granted'
  ) then raise exception using errcode = '42501', message = 'clinical_record_consent_required'; end if;
  return query
    with latest as (
      select distinct on (r.record_key) r.*
      from clinical_core.consumer_clinical_record_versions r
      where r.connection_id = _connection_id and r.collection = _collection
      order by r.record_key, r.received_at desc, r.id desc
    )
    select l.id, l.stable_record_id, l.record_key, l.resource_version, l.payload,
      l.payload_sha256, l.deleted, l.received_at from latest l
    where (_after_received_at is null or (l.received_at,l.id) > (_after_received_at,_after_id))
    order by l.received_at,l.id limit _limit;
end
$$;

create or replace function clinical_core.list_consumer_consent_history(_connection_id uuid)
returns table(scope text, status text, recorded_at timestamptz, version integer,
  method text, representative_authority text)
language plpgsql stable security definer set search_path = '' as $$
declare _connection clinical_core.patient_connections%rowtype;
begin
  select * into _connection from clinical_core.patient_connections c where c.id = _connection_id;
  if not found then raise exception using errcode = 'P0002', message = 'connection_required'; end if;
  perform clinical_private.assert_synthetic_context(_connection.organization_id, 'consent_management', 'consumer');
  if _connection.consumer_person_id <> clinical_private.actor_person_id() then
    raise exception using errcode = '42501', message = 'consumer_connection_refused';
  end if;
  return query select g.scope,g.status,g.recorded_at,g.version,g.method,g.representative_authority
    from clinical_core.consent_grants g where g.connection_id = _connection_id
    order by g.recorded_at desc,g.id desc limit 500;
end
$$;

create or replace function clinical_core.submit_privacy_request(
  _connection_id uuid, _kind text, _detail text default null
)
returns table(request_id uuid, kind text, status text, detail text,
  submitted_at timestamptz, resolved_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  _connection clinical_core.patient_connections%rowtype;
  _request clinical_core.privacy_requests%rowtype;
begin
  select * into _connection from clinical_core.patient_connections c
    where c.id = _connection_id and c.state in ('verified','paused');
  if not found then raise exception using errcode = 'P0002', message = 'connection_required'; end if;
  perform clinical_private.assert_synthetic_context(_connection.organization_id, 'consent_management', 'consumer');
  if _connection.consumer_person_id <> clinical_private.actor_person_id()
    or _kind not in ('export','correction','deletion')
    or (_detail is not null and char_length(btrim(_detail)) not between 1 and 1000) then
    raise exception using errcode = '22023', message = 'privacy_request_invalid';
  end if;
  insert into clinical_core.privacy_requests(
    organization_id,patient_record_id,connection_id,requested_by_person_id,kind,detail
  ) values (
    _connection.organization_id,_connection.patient_record_id,_connection.id,
    clinical_private.actor_person_id(),_kind,nullif(btrim(_detail),'')
  ) returning * into _request;
  insert into clinical_audit.events(organization_id,actor_person_id,action,
    resource_type,resource_id,purpose,safe_metadata)
  values (_connection.organization_id,clinical_private.actor_person_id(),
    'privacy_request.submitted','privacy_request',_request.id,'consent_management',
    jsonb_build_object('kind',_kind));
  return query select _request.id,_request.kind,_request.status,_request.detail,
    _request.submitted_at,_request.resolved_at;
end
$$;

create or replace function clinical_core.list_consumer_privacy_requests(_connection_id uuid)
returns table(request_id uuid, kind text, status text, detail text,
  submitted_at timestamptz, resolved_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare _connection clinical_core.patient_connections%rowtype;
begin
  select * into _connection from clinical_core.patient_connections c where c.id = _connection_id;
  if not found then raise exception using errcode = 'P0002', message = 'connection_required'; end if;
  perform clinical_private.assert_synthetic_context(_connection.organization_id, 'consent_management', 'consumer');
  if _connection.consumer_person_id <> clinical_private.actor_person_id() then
    raise exception using errcode = '42501', message = 'consumer_connection_refused';
  end if;
  return query select r.id,r.kind,r.status,r.detail,r.submitted_at,r.resolved_at
    from clinical_core.privacy_requests r where r.connection_id = _connection_id
    order by r.submitted_at desc,r.id desc limit 500;
end
$$;

create trigger consumer_clinical_versions_append_only
  before update or delete on clinical_core.consumer_clinical_record_versions
  for each row execute function clinical_private.block_update_delete();
create trigger privacy_requests_no_delete
  before delete on clinical_core.privacy_requests
  for each row execute function clinical_private.block_update_delete();

alter table clinical_core.consumer_clinical_record_versions enable row level security;
alter table clinical_core.privacy_requests enable row level security;
create policy consumer_clinical_records_read on clinical_core.consumer_clinical_record_versions for select
  using (organization_id = clinical_private.organization_id() and (
    clinical_private.has_clinical_role(organization_id) or consumer_person_id = clinical_private.actor_person_id()));
create policy privacy_requests_read on clinical_core.privacy_requests for select
  using (organization_id = clinical_private.organization_id() and (
    clinical_private.has_clinical_role(organization_id) or requested_by_person_id = clinical_private.actor_person_id()));

grant select on clinical_core.consumer_clinical_record_versions,
  clinical_core.privacy_requests to clinical_core_api;
grant execute on function clinical_core.record_consumer_clinical_version(
  uuid,uuid,text,text,text,text,jsonb,text,boolean) to clinical_core_api;
grant execute on function clinical_core.list_consumer_clinical_records(
  uuid,text,timestamptz,uuid,integer) to clinical_core_api;
grant execute on function clinical_core.list_consumer_consent_history(uuid) to clinical_core_api;
grant execute on function clinical_core.submit_privacy_request(uuid,text,text) to clinical_core_api;
grant execute on function clinical_core.list_consumer_privacy_requests(uuid) to clinical_core_api;

revoke all on all tables in schema clinical_core from public;
revoke all on all functions in schema clinical_core from public;
