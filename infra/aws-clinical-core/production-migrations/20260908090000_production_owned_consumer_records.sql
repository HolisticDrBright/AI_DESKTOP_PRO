-- Personal storage is not clinic sharing. No public route or PHI activation is
-- added here. Consent releases require separate human review; none are seeded.
create table clinical_private.consumer_storage_consent_releases (
  scope text not null check (scope in ('forms_checkins','symptoms_adherence','nutrition','protocols_supplements','wearables','reproductive_health')),
  version text not null check (length(version) between 1 and 80),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  approved_by text not null check (length(trim(approved_by)) between 1 and 160),
  approved_at timestamptz not null,
  retired_at timestamptz,
  primary key(scope, version)
);

create table clinical_core.consumer_storage_consents (
  owner_id uuid not null references clinical_core.persons(id),
  scope text not null,
  revision integer not null check (revision > 0),
  status text not null check (status in ('granted','revoked')),
  release_version text not null,
  recorded_at timestamptz not null default clock_timestamp(),
  primary key(owner_id, scope, revision),
  foreign key(scope, release_version) references clinical_private.consumer_storage_consent_releases(scope, version)
);

create table clinical_core.owned_consumer_record_versions (
  owner_id uuid not null references clinical_core.persons(id),
  collection text not null check (collection in (
    'protocols','daily_adherence','symptom_logs','hormone_entries','meal_logs',
    'subjective_rollups','weekly_checkins','wellness_profiles','lifestyle_profiles',
    'contraindications','questionnaire_responses','clinical_intakes',
    'wearable_daily_records','reproductive_profiles','adverse_event_reports')),
  record_id uuid not null,
  revision integer not null check (revision > 0),
  request_id uuid not null,
  command_sha256 text not null check (command_sha256 ~ '^[0-9a-f]{64}$'),
  payload jsonb not null check (jsonb_typeof(payload)='object' and octet_length(payload::text)<=16384),
  deleted boolean not null,
  consent_revision integer not null check (consent_revision > 0),
  received_at timestamptz not null default clock_timestamp(),
  primary key(owner_id, collection, record_id, revision),
  unique(owner_id, request_id),
  check (not deleted or payload='{}'::jsonb)
);

create table clinical_audit.consumer_storage_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references clinical_core.persons(id),
  action text not null check (action in ('consent.granted','consent.revoked','record.written','record.deleted','records.listed')),
  collection text,
  record_id uuid,
  revision integer,
  recorded_at timestamptz not null default clock_timestamp()
);
create index consumer_storage_audit_owner_time on clinical_audit.consumer_storage_events(owner_id, recorded_at, id);

-- Revalidate the identity, not just a caller-supplied person or organization.
-- Null claims fail closed, including when no request context was established.
create function clinical_private.owned_consumer_actor()
returns uuid language plpgsql stable security definer set search_path='' as $$
declare _actor uuid:=clinical_private.actor_person_id();
begin
  if clinical_private.claim('identity_pool') is distinct from 'consumer'
    or clinical_private.claim('purpose') is null
    or clinical_private.claim('purpose') not in ('clinical_data','consent_management')
    or clinical_private.claim('environment') is distinct from 'production-clinical'
    or clinical_private.claim('data_classification') is distinct from 'clinical_phi'
    or not exists(select 1 from clinical_core.identities i
      join clinical_core.persons p on p.id=i.person_id
      where i.person_id=_actor and i.identity_pool='consumer'
        and i.identity_subject=clinical_private.claim('identity_subject')
        and i.production_bound=true and i.status='active' and p.status='active') then
    raise exception using errcode='42501',message='consumer_owner_required';
  end if;
  return _actor;
end $$;

create function clinical_private.owned_consumer_consent(_owner uuid,_scope text)
returns integer language sql stable security definer set search_path='' as $$
  select case when c.status='granted' and r.retired_at is null then c.revision else null end
  from (select * from clinical_core.consumer_storage_consents
    where owner_id=_owner and _owner=clinical_private.owned_consumer_actor()
      and scope=_scope order by revision desc limit 1) c
  join clinical_private.consumer_storage_consent_releases r
    on r.scope=c.scope and r.version=c.release_version
$$;

alter table clinical_private.consumer_storage_consent_releases enable row level security;
alter table clinical_private.consumer_storage_consent_releases force row level security;
alter table clinical_core.consumer_storage_consents enable row level security;
alter table clinical_core.consumer_storage_consents force row level security;
alter table clinical_core.owned_consumer_record_versions enable row level security;
alter table clinical_core.owned_consumer_record_versions force row level security;
alter table clinical_audit.consumer_storage_events enable row level security;
alter table clinical_audit.consumer_storage_events force row level security;
create policy consumer_storage_consent_owner on clinical_core.consumer_storage_consents for select to clinical_core_api
  using (owner_id=(select clinical_private.owned_consumer_actor()));
create policy owned_consumer_record_owner on clinical_core.owned_consumer_record_versions for select to clinical_core_api
  using (owner_id=(select clinical_private.owned_consumer_actor()) and
    clinical_private.owned_consumer_consent(owner_id,clinical_private.consumer_collection_scope(collection)) is not null);
create policy consumer_storage_audit_owner on clinical_audit.consumer_storage_events for select to clinical_core_api
  using (owner_id=(select clinical_private.owned_consumer_actor()));

create function clinical_core.set_owned_consumer_consent(_scope text,_status text,_release text,_expected_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _current integer; _version text; _next integer;
begin
  if clinical_private.claim('purpose') is distinct from 'consent_management'
    or _status is null or _status not in ('granted','revoked')
    or _expected_revision is null or _expected_revision<0 then
    raise exception using errcode='22023',message='consent_request_invalid';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(_actor::text,0));
  select revision,release_version into _current,_version from clinical_core.consumer_storage_consents
    where owner_id=_actor and scope=_scope order by revision desc limit 1;
  if coalesce(_current,0)<>_expected_revision then
    raise exception using errcode='40001',message='consent_revision_conflict';
  end if;
  if _status='granted' then
    if not exists(select 1 from clinical_private.consumer_storage_consent_releases
      where scope=_scope and version=_release and retired_at is null and approved_at<=clock_timestamp()) then
      raise exception using errcode='42501',message='reviewed_consent_release_required';
    end if;
    _version:=_release;
  elsif _current is null then
    raise exception using errcode='22023',message='consent_request_invalid';
  end if;
  _next:=coalesce(_current,0)+1;
  insert into clinical_core.consumer_storage_consents(owner_id,scope,revision,status,release_version)
    values(_actor,_scope,_next,_status,_version);
  insert into clinical_audit.consumer_storage_events(owner_id,action,revision)
    values(_actor,'consent.'||_status,_next);
  return jsonb_build_object('scope',_scope,'status',_status,'revision',_next,'releaseVersion',_version);
end $$;

create function clinical_core.write_owned_consumer_record(
  _collection text,_record_id uuid,_expected_revision integer,_request_id uuid,
  _payload jsonb,_deleted boolean,_consent_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _scope text; _current integer;
  _hash text; _previous clinical_core.owned_consumer_record_versions; _saved clinical_core.owned_consumer_record_versions;
begin
  _scope:=clinical_private.consumer_collection_scope(_collection);
  if clinical_private.claim('purpose') is distinct from 'clinical_data'
    or _scope is null or _record_id is null or _request_id is null or _deleted is null
    or _expected_revision is null or _expected_revision<0 or _consent_revision is null
    or _payload is null or jsonb_typeof(_payload)<>'object' or octet_length(_payload::text)>16384
    or (_deleted and _payload<>'{}'::jsonb) then
    raise exception using errcode='22023',message='owned_record_request_invalid';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(_actor::text,0));
  if clinical_private.owned_consumer_consent(_actor,_scope) is distinct from _consent_revision then
    raise exception using errcode='42501',message='consumer_storage_consent_required';
  end if;
  _hash:=encode(public.digest(jsonb_build_array(_collection,_record_id,_expected_revision,_payload,_deleted,_consent_revision)::text,'sha256'),'hex');
  select * into _previous from clinical_core.owned_consumer_record_versions where owner_id=_actor and request_id=_request_id;
  if found then
    if _previous.command_sha256<>_hash then
      raise exception using errcode='40001',message='owned_record_idempotency_conflict';
    end if;
    return jsonb_build_object('recordId',_previous.record_id,'revision',_previous.revision,'duplicate',true,'receivedAt',_previous.received_at);
  end if;
  select max(revision) into _current from clinical_core.owned_consumer_record_versions
    where owner_id=_actor and collection=_collection and record_id=_record_id;
  if coalesce(_current,0)<>_expected_revision then
    raise exception using errcode='40001',message='owned_record_revision_conflict';
  end if;
  insert into clinical_core.owned_consumer_record_versions
    (owner_id,collection,record_id,revision,request_id,command_sha256,payload,deleted,consent_revision)
    values(_actor,_collection,_record_id,coalesce(_current,0)+1,_request_id,_hash,_payload,_deleted,_consent_revision)
    returning * into _saved;
  insert into clinical_audit.consumer_storage_events(owner_id,action,collection,record_id,revision)
    values(_actor,case when _deleted then 'record.deleted' else 'record.written' end,_collection,_record_id,_saved.revision);
  return jsonb_build_object('recordId',_saved.record_id,'revision',_saved.revision,'duplicate',false,'receivedAt',_saved.received_at);
end $$;

create function clinical_core.list_owned_consumer_records(_collection text,_limit integer,
  _after_time timestamptz default null,_after_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare _actor uuid:=clinical_private.owned_consumer_actor(); _records jsonb;
begin
  if clinical_private.claim('purpose') is distinct from 'clinical_data'
    or _limit is null or _limit<1 or _limit>100 or ((_after_time is null)<>(_after_id is null)) then
    raise exception using errcode='22023',message='owned_record_request_invalid';
  end if;
  if clinical_private.owned_consumer_consent(_actor,clinical_private.consumer_collection_scope(_collection)) is null then
    raise exception using errcode='42501',message='consumer_storage_consent_required';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('recordId',r.record_id,'revision',r.revision,
    'payload',r.payload,'receivedAt',r.received_at) order by r.received_at,r.record_id),'[]'::jsonb) into _records
  from (select * from (select distinct on (record_id) * from clinical_core.owned_consumer_record_versions
      where owner_id=_actor and collection=_collection order by record_id,revision desc) latest
    where not deleted and (_after_time is null or (received_at,record_id)>(_after_time,_after_id))
    order by received_at,record_id limit _limit) r;
  insert into clinical_audit.consumer_storage_events(owner_id,action,collection) values(_actor,'records.listed',_collection);
  return _records;
end $$;

revoke all on clinical_private.consumer_storage_consent_releases,clinical_core.consumer_storage_consents,
  clinical_core.owned_consumer_record_versions,clinical_audit.consumer_storage_events from public,clinical_core_api;
grant select on clinical_core.consumer_storage_consents,clinical_core.owned_consumer_record_versions,
  clinical_audit.consumer_storage_events to clinical_core_api;
revoke all on function clinical_private.owned_consumer_actor(),clinical_private.owned_consumer_consent(uuid,text),
  clinical_core.set_owned_consumer_consent(text,text,text,integer),
  clinical_core.write_owned_consumer_record(text,uuid,integer,uuid,jsonb,boolean,integer),
  clinical_core.list_owned_consumer_records(text,integer,timestamptz,uuid) from public;
grant execute on function clinical_private.owned_consumer_actor(),clinical_private.owned_consumer_consent(uuid,text),
  clinical_core.set_owned_consumer_consent(text,text,text,integer),
  clinical_core.write_owned_consumer_record(text,uuid,integer,uuid,jsonb,boolean,integer),
  clinical_core.list_owned_consumer_records(text,integer,timestamptz,uuid) to clinical_core_api;
