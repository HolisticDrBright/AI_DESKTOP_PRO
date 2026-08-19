-- AWS-native, synthetic-only App -> Desktop lab import.
-- Raw documents, contact details, interpretations, and recommendations are excluded.

alter table clinical_core.consent_artifacts
  drop constraint consent_artifacts_scope_check;
alter table clinical_core.consent_artifacts
  add constraint consent_artifacts_scope_check check (scope in (
    'programs','protocols_supplements','nutrition','appointments','messaging',
    'forms_checkins','symptoms_adherence','wearables','lab_summaries',
    'lab_results_import','billing_links','research_n_of_1'));

alter table clinical_core.consent_grants
  drop constraint consent_grants_scope_check;
alter table clinical_core.consent_grants
  add constraint consent_grants_scope_check check (scope in (
    'programs','protocols_supplements','nutrition','appointments','messaging',
    'forms_checkins','symptoms_adherence','wearables','lab_summaries',
    'lab_results_import','billing_links','research_n_of_1'));

alter table clinical_audit.events drop constraint events_action_check;
alter table clinical_audit.events add constraint events_action_check check (action in (
  'connection.invitation_issued','connection.invitation_claimed',
  'consent.granted','consent.revoked','lab_import.received',
  'lab_import.duplicate','lab_import.accepted','lab_import.rejected'));
alter table clinical_audit.events drop constraint events_resource_type_check;
alter table clinical_audit.events add constraint events_resource_type_check
  check (resource_type in ('connection','consent','lab_import'));
alter table clinical_audit.events drop constraint events_purpose_check;
alter table clinical_audit.events add constraint events_purpose_check
  check (purpose in ('identity_link','consent_management','clinical_data'));

create table clinical_core.sync_providers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  stable_id text not null check (stable_id ~ '^[a-z][a-z0-9_]{2,63}$'),
  contract_version text not null check (contract_version = 'patient-sync/1'),
  lab_contract_version text not null check (lab_contract_version = 'lab-result/1'),
  adapter_version text not null check (char_length(adapter_version) between 1 and 64),
  state text not null check (state in ('pending_review','active','suspended','retired')),
  reviewed_by_person_id uuid references clinical_core.persons(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique (organization_id, stable_id),
  check ((state = 'active' and reviewed_by_person_id is not null and reviewed_at is not null)
    or state <> 'active')
);
create index sync_providers_org_idx on clinical_core.sync_providers(organization_id);

create table clinical_core.lab_import_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null references clinical_core.patient_records(id),
  connection_id uuid not null references clinical_core.patient_connections(id),
  provider_id uuid not null references clinical_core.sync_providers(id),
  provider_event_id text not null check (provider_event_id ~ '^[A-Za-z0-9:_-]{8,160}$'),
  external_panel_id text not null check (external_panel_id ~ '^[A-Za-z0-9:_-]{1,160}$'),
  external_marker_id text not null check (external_marker_id ~ '^[A-Za-z0-9:_-]{1,160}$'),
  resource_version text not null check (resource_version ~ '^[A-Za-z0-9._:-]{1,64}$'),
  panel_name text not null check (char_length(panel_name) between 1 and 200),
  source_label text check (source_label is null or char_length(source_label) between 1 and 200),
  marker_name text not null check (char_length(marker_name) between 1 and 200),
  value_numeric numeric not null,
  unit text check (unit is null or char_length(unit) between 1 and 80),
  reference_min numeric,
  reference_max numeric,
  source_status text check (source_status is null or source_status in ('low','normal','high','critical','optimal','unknown')),
  collected_at timestamptz not null,
  occurred_at timestamptz not null,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  state text not null default 'review_pending'
    check (state in ('review_pending','accepted','rejected','conflict')),
  received_at timestamptz not null default clock_timestamp(),
  reviewed_at timestamptz,
  reviewed_by_person_id uuid references clinical_core.persons(id),
  review_note text check (review_note is null or char_length(review_note) between 1 and 500),
  foreign key (connection_id, organization_id, patient_record_id)
    references clinical_core.patient_connections(id, organization_id, patient_record_id),
  unique (provider_id, connection_id, provider_event_id),
  check (collected_at <= occurred_at + interval '1 day'),
  check ((state in ('accepted','rejected') and reviewed_at is not null and reviewed_by_person_id is not null)
    or (state in ('review_pending','conflict') and reviewed_at is null and reviewed_by_person_id is null))
);
create index lab_import_events_review_idx
  on clinical_core.lab_import_events(organization_id, state, received_at);
create index lab_import_events_patient_idx
  on clinical_core.lab_import_events(patient_record_id, collected_at desc);
create unique index lab_import_events_current_resource_uniq
  on clinical_core.lab_import_events(provider_id, connection_id, external_panel_id, external_marker_id, resource_version);

create table clinical_core.lab_observations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null references clinical_core.patient_records(id),
  import_event_id uuid not null unique references clinical_core.lab_import_events(id),
  panel_name text not null check (char_length(panel_name) between 1 and 200),
  marker_name text not null check (char_length(marker_name) between 1 and 200),
  value_numeric numeric not null,
  unit text check (unit is null or char_length(unit) between 1 and 80),
  reference_min numeric,
  reference_max numeric,
  observed_at timestamptz not null,
  review_status text not null default 'unreviewed'
    check (review_status in ('unreviewed','reviewed','rejected')),
  provenance jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  reviewed_at timestamptz,
  reviewed_by_person_id uuid references clinical_core.persons(id),
  check (jsonb_typeof(provenance) = 'object'),
  check (not (provenance ?| array['email','name','phone','date_of_birth','dob','authorization','cookie','payload'])),
  unique (organization_id, patient_record_id, import_event_id)
);
create index lab_observations_patient_idx
  on clinical_core.lab_observations(patient_record_id, observed_at desc);

create or replace function clinical_private.set_request_context(
  _actor_person_id uuid,
  _organization_id uuid,
  _identity_pool text,
  _identity_subject text,
  _purpose text,
  _environment text,
  _data_classification text
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if _identity_pool not in ('workforce','consumer')
    or _purpose not in ('identity_link','consent_management','clinical_data')
    or _environment <> 'synthetic-staging'
    or _data_classification <> 'synthetic_only'
    or not exists (
      select 1 from clinical_core.identities i
      join clinical_core.persons p on p.id = i.person_id
      where i.person_id = _actor_person_id
        and i.identity_pool = _identity_pool
        and i.identity_subject = _identity_subject
        and i.synthetic_attested = true
        and i.status = 'active'
        and p.status = 'active'
        and p.contains_phi = false
    ) then
    raise exception using errcode = '42501', message = 'request_context_refused';
  end if;
  perform set_config('clinical.claim.actor_person_id', _actor_person_id::text, true);
  perform set_config('clinical.claim.organization_id', _organization_id::text, true);
  perform set_config('clinical.claim.identity_pool', _identity_pool, true);
  perform set_config('clinical.claim.identity_subject', _identity_subject, true);
  perform set_config('clinical.claim.purpose', _purpose, true);
  perform set_config('clinical.claim.environment', _environment, true);
  perform set_config('clinical.claim.data_classification', _data_classification, true);
end
$$;

create or replace function clinical_core.record_lab_import(
  _connection_id uuid, _provider_stable_id text, _provider_event_id text,
  _external_panel_id text, _external_marker_id text, _resource_version text,
  _panel_name text, _source_label text, _marker_name text, _value_numeric numeric,
  _unit text, _reference_min numeric, _reference_max numeric, _source_status text,
  _collected_at timestamptz, _occurred_at timestamptz, _payload_sha256 text
)
returns table(event_id uuid, state text, duplicate boolean)
language plpgsql security definer set search_path = '' as $$
declare
  _connection clinical_core.patient_connections%rowtype;
  _provider clinical_core.sync_providers%rowtype;
  _event clinical_core.lab_import_events%rowtype;
  _state text := 'review_pending';
begin
  select * into _connection from clinical_core.patient_connections c
    where c.id = _connection_id and c.state = 'verified';
  if not found then raise exception using errcode = 'P0002', message = 'verified_connection_required'; end if;
  perform clinical_private.assert_synthetic_context(_connection.organization_id, 'clinical_data', 'consumer');
  if _connection.consumer_person_id <> clinical_private.actor_person_id() then
    raise exception using errcode = '42501', message = 'consumer_connection_refused';
  end if;
  if not exists (
    select 1 from clinical_core.current_consent c
    where c.connection_id = _connection_id and c.scope = 'lab_results_import' and c.status = 'granted'
  ) then raise exception using errcode = '42501', message = 'lab_import_consent_required'; end if;
  select * into _provider from clinical_core.sync_providers p
    where p.organization_id = _connection.organization_id
      and p.stable_id = _provider_stable_id and p.state = 'active'
      and p.contract_version = 'patient-sync/1' and p.lab_contract_version = 'lab-result/1';
  if not found then raise exception using errcode = '42501', message = 'approved_provider_required'; end if;
  if _occurred_at > clock_timestamp() + interval '5 minutes'
    or _occurred_at < clock_timestamp() - interval '30 days'
    or _collected_at > clock_timestamp() + interval '1 day'
    or _payload_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'lab_import_invalid';
  end if;

  select * into _event from clinical_core.lab_import_events e
    where e.provider_id = _provider.id and e.connection_id = _connection_id
      and e.provider_event_id = _provider_event_id;
  if found then
    if _event.payload_sha256 <> _payload_sha256 then
      raise exception using errcode = '40001', message = 'provider_event_conflict';
    end if;
    insert into clinical_audit.events(organization_id, actor_person_id, action,
      resource_type, resource_id, purpose, safe_metadata)
    values (_connection.organization_id, clinical_private.actor_person_id(),
      'lab_import.duplicate', 'lab_import', _event.id, 'clinical_data',
      jsonb_build_object('provider', _provider_stable_id));
    return query select _event.id, _event.state, true;
    return;
  end if;

  select * into _event from clinical_core.lab_import_events e
    where e.provider_id = _provider.id and e.connection_id = _connection_id
      and e.external_panel_id = _external_panel_id and e.external_marker_id = _external_marker_id
      and e.resource_version = _resource_version;
  if found then
    if _event.payload_sha256 <> _payload_sha256 then
      raise exception using errcode = '40001', message = 'resource_version_conflict';
    end if;
    insert into clinical_audit.events(organization_id, actor_person_id, action,
      resource_type, resource_id, purpose, safe_metadata)
    values (_connection.organization_id, clinical_private.actor_person_id(),
      'lab_import.duplicate', 'lab_import', _event.id, 'clinical_data',
      jsonb_build_object('provider', _provider_stable_id));
    return query select _event.id, _event.state, true;
    return;
  end if;

  if exists (
    select 1 from clinical_core.lab_import_events e
    where e.provider_id = _provider.id and e.connection_id = _connection_id
      and e.external_panel_id = _external_panel_id and e.external_marker_id = _external_marker_id
  ) then _state := 'conflict'; end if;

  insert into clinical_core.lab_import_events(
    organization_id, patient_record_id, connection_id, provider_id,
    provider_event_id, external_panel_id, external_marker_id, resource_version,
    panel_name, source_label, marker_name, value_numeric, unit, reference_min,
    reference_max, source_status, collected_at, occurred_at, payload_sha256, state
  ) values (
    _connection.organization_id, _connection.patient_record_id, _connection.id, _provider.id,
    _provider_event_id, _external_panel_id, _external_marker_id, _resource_version,
    _panel_name, nullif(_source_label,''), _marker_name, _value_numeric, nullif(_unit,''),
    _reference_min, _reference_max, nullif(_source_status,''), _collected_at,
    _occurred_at, _payload_sha256, _state
  ) returning id into _event.id;
  insert into clinical_audit.events(organization_id, actor_person_id, action,
    resource_type, resource_id, purpose, safe_metadata)
  values (_connection.organization_id, clinical_private.actor_person_id(),
    'lab_import.received', 'lab_import', _event.id, 'clinical_data',
    jsonb_build_object('provider', _provider_stable_id, 'state', _state));
  return query select _event.id, _state, false;
end
$$;

create or replace function clinical_core.review_lab_import(
  _event_id uuid, _decision text, _note text default null
)
returns table(event_id uuid, state text, observation_id uuid, duplicate boolean)
language plpgsql security definer set search_path = '' as $$
declare
  _event clinical_core.lab_import_events%rowtype;
  _observation_id uuid;
  _inserted integer := 0;
begin
  select * into _event from clinical_core.lab_import_events e where e.id = _event_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'lab_import_not_found'; end if;
  perform clinical_private.assert_synthetic_context(_event.organization_id, 'clinical_data', 'workforce');
  if not clinical_private.has_clinical_role(_event.organization_id) then
    raise exception using errcode = '42501', message = 'clinical_role_required';
  end if;
  if _decision not in ('accept','reject')
    or (_decision = 'reject' and coalesce(char_length(btrim(_note)),0) = 0) then
    raise exception using errcode = '22023', message = 'review_decision_invalid';
  end if;
  if _event.state in ('accepted','rejected') then
    select o.id into _observation_id from clinical_core.lab_observations o where o.import_event_id = _event.id;
    return query select _event.id, _event.state, _observation_id, true;
    return;
  end if;
  if _event.state = 'conflict' and _decision = 'accept' and coalesce(char_length(btrim(_note)),0) = 0 then
    raise exception using errcode = '22023', message = 'conflict_acceptance_note_required';
  end if;
  if _decision = 'accept' then
    insert into clinical_core.lab_observations(
      organization_id, patient_record_id, import_event_id, panel_name, marker_name,
      value_numeric, unit, reference_min, reference_max, observed_at, provenance
    ) values (
      _event.organization_id, _event.patient_record_id, _event.id, _event.panel_name,
      _event.marker_name, _event.value_numeric, _event.unit, _event.reference_min,
      _event.reference_max, _event.collected_at,
      jsonb_build_object('sourceSystem','ai_longevity_pro_v2','providerEventId',_event.provider_event_id,
        'externalPanelId',_event.external_panel_id,'externalMarkerId',_event.external_marker_id,
        'resourceVersion',_event.resource_version,'payloadSha256',_event.payload_sha256,
        'acceptedBy',clinical_private.actor_person_id(),'acceptedAt',clock_timestamp())
    ) on conflict (import_event_id) do nothing returning id into _observation_id;
    get diagnostics _inserted = row_count;
    if _observation_id is null then
      select o.id into _observation_id from clinical_core.lab_observations o where o.import_event_id = _event.id;
    end if;
  end if;
  update clinical_core.lab_import_events e
    set state = case when _decision = 'accept' then 'accepted' else 'rejected' end,
      reviewed_at = clock_timestamp(), reviewed_by_person_id = clinical_private.actor_person_id(),
      review_note = nullif(left(btrim(coalesce(_note,'')),500),'')
    where e.id = _event.id;
  insert into clinical_audit.events(organization_id, actor_person_id, action,
    resource_type, resource_id, purpose, safe_metadata)
  values (_event.organization_id, clinical_private.actor_person_id(),
    case when _decision = 'accept' then 'lab_import.accepted' else 'lab_import.rejected' end,
    'lab_import', _event.id, 'clinical_data',
    jsonb_build_object('observation_created', _inserted = 1));
  return query select _event.id,
    case when _decision = 'accept' then 'accepted' else 'rejected' end,
    _observation_id, false;
end
$$;

create or replace function clinical_core.list_lab_imports(_state text default 'review_pending')
returns table(event_id uuid, patient_record_id uuid, connection_id uuid, panel_name text,
  marker_name text, value_numeric numeric, unit text, source_status text,
  collected_at timestamptz, state text, received_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform clinical_private.assert_synthetic_context(clinical_private.organization_id(), 'clinical_data', 'workforce');
  if not clinical_private.has_clinical_role(clinical_private.organization_id())
    or _state not in ('review_pending','conflict','accepted','rejected') then
    raise exception using errcode = '42501', message = 'clinical_role_required';
  end if;
  return query select e.id, e.patient_record_id, e.connection_id, e.panel_name,
    e.marker_name, e.value_numeric, e.unit, e.source_status, e.collected_at,
    e.state, e.received_at from clinical_core.lab_import_events e
    where e.organization_id = clinical_private.organization_id() and e.state = _state
    order by e.received_at asc limit 500;
end
$$;

create or replace function clinical_core.list_patient_lab_observations(_patient_record_id uuid)
returns table(observation_id uuid, panel_name text, marker_name text, value_numeric numeric,
  unit text, reference_min numeric, reference_max numeric, observed_at timestamptz,
  review_status text, provenance jsonb)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform clinical_private.assert_synthetic_context(clinical_private.organization_id(), 'clinical_data', null);
  if not exists (
    select 1 from clinical_core.patient_records p where p.id = _patient_record_id
      and p.organization_id = clinical_private.organization_id()
      and (clinical_private.has_clinical_role(p.organization_id) or exists (
        select 1 from clinical_core.patient_connections c where c.patient_record_id = p.id
          and c.consumer_person_id = clinical_private.actor_person_id() and c.state in ('verified','paused')
      ))
  ) then raise exception using errcode = '42501', message = 'patient_access_refused'; end if;
  return query select o.id, o.panel_name, o.marker_name, o.value_numeric, o.unit,
    o.reference_min, o.reference_max, o.observed_at, o.review_status, o.provenance
    from clinical_core.lab_observations o
    where o.organization_id = clinical_private.organization_id()
      and o.patient_record_id = _patient_record_id
    order by o.observed_at desc, o.id limit 1000;
end
$$;

create trigger lab_import_events_no_delete before delete on clinical_core.lab_import_events
  for each row execute function clinical_private.block_update_delete();
create trigger lab_observations_no_delete before delete on clinical_core.lab_observations
  for each row execute function clinical_private.block_update_delete();

alter table clinical_core.sync_providers enable row level security;
alter table clinical_core.lab_import_events enable row level security;
alter table clinical_core.lab_observations enable row level security;
create policy sync_providers_read on clinical_core.sync_providers for select
  using (organization_id = clinical_private.organization_id() and clinical_private.has_clinical_role(organization_id));
create policy lab_import_events_read on clinical_core.lab_import_events for select
  using (organization_id = clinical_private.organization_id() and clinical_private.has_clinical_role(organization_id));
create policy lab_observations_read on clinical_core.lab_observations for select
  using (organization_id = clinical_private.organization_id() and (
    clinical_private.has_clinical_role(organization_id) or exists (
      select 1 from clinical_core.patient_connections c where c.patient_record_id = lab_observations.patient_record_id
        and c.consumer_person_id = clinical_private.actor_person_id() and c.state in ('verified','paused'))));

grant select on clinical_core.sync_providers, clinical_core.lab_import_events,
  clinical_core.lab_observations to clinical_core_api;
grant execute on function clinical_core.record_lab_import(uuid,text,text,text,text,text,text,text,text,numeric,text,numeric,numeric,text,timestamptz,timestamptz,text)
  to clinical_core_api;
grant execute on function clinical_core.review_lab_import(uuid,text,text) to clinical_core_api;
grant execute on function clinical_core.list_lab_imports(text) to clinical_core_api;
grant execute on function clinical_core.list_patient_lab_observations(uuid) to clinical_core_api;

revoke all on all tables in schema clinical_core from public;
revoke all on all functions in schema clinical_core from public;
