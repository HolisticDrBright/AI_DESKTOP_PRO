-- Shared AWS clinical core: synthetic identity, explicit linking, and consent.
-- PostgreSQL/Aurora portable: no Supabase auth schema, auth.uid(), or PostgREST.
-- This migration is deliberately incapable of storing real-patient data.

create extension if not exists pgcrypto;
create schema if not exists clinical_core;
create schema if not exists clinical_private;
create schema if not exists clinical_audit;

revoke all on schema clinical_private from public;
revoke all on schema clinical_audit from public;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'clinical_core_api') then
    create role clinical_core_api nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'clinical_core_migrator') then
    create role clinical_core_migrator nologin noinherit;
  end if;
  execute format('grant clinical_core_api, clinical_core_migrator to %I', current_user);
end
$$;

grant usage on schema clinical_core to clinical_core_api;
grant usage on schema clinical_private, clinical_audit to clinical_core_api;
revoke all on all tables in schema clinical_core from public, clinical_core_api;
revoke all on all functions in schema clinical_core from public, clinical_core_api;
revoke all on all functions in schema clinical_private from public, clinical_core_api;

create table clinical_core.organizations (
  id uuid primary key default gen_random_uuid(),
  synthetic_label text not null check (char_length(synthetic_label) between 1 and 120),
  environment text not null default 'synthetic-staging'
    check (environment = 'synthetic-staging'),
  data_classification text not null default 'synthetic_only'
    check (data_classification = 'synthetic_only'),
  contains_phi boolean not null default false check (contains_phi = false),
  status text not null default 'active' check (status in ('active','suspended','archived')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table clinical_core.persons (
  id uuid primary key default gen_random_uuid(),
  synthetic_subject_key text not null unique
    check (synthetic_subject_key ~ '^syn_[A-Za-z0-9_-]{8,96}$'),
  data_classification text not null default 'synthetic_only'
    check (data_classification = 'synthetic_only'),
  contains_phi boolean not null default false check (contains_phi = false),
  status text not null default 'active' check (status in ('active','disabled')),
  created_at timestamptz not null default clock_timestamp()
);

create table clinical_core.identities (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references clinical_core.persons(id),
  identity_pool text not null check (identity_pool in ('workforce','consumer')),
  identity_subject text not null check (identity_subject ~ '^[A-Za-z0-9:_-]{8,128}$'),
  synthetic_attested boolean not null check (synthetic_attested = true),
  status text not null default 'active' check (status in ('active','disabled')),
  created_at timestamptz not null default clock_timestamp(),
  unique (identity_pool, identity_subject),
  unique (person_id, identity_pool)
);
create index identities_person_idx on clinical_core.identities(person_id);

create table clinical_core.organization_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  person_id uuid not null references clinical_core.persons(id),
  role text not null check (role in ('owner','admin','practitioner','staff')),
  status text not null default 'active' check (status in ('active','suspended')),
  created_at timestamptz not null default clock_timestamp(),
  unique (organization_id, person_id)
);
create index organization_memberships_person_idx
  on clinical_core.organization_memberships(person_id);

create table clinical_core.patient_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  synthetic_record_key text not null check (synthetic_record_key ~ '^patient_syn_[A-Za-z0-9_-]{8,96}$'),
  data_classification text not null default 'synthetic_only'
    check (data_classification = 'synthetic_only'),
  contains_phi boolean not null default false check (contains_phi = false),
  status text not null default 'active' check (status in ('active','archived')),
  created_at timestamptz not null default clock_timestamp(),
  unique (organization_id, synthetic_record_key),
  unique (id, organization_id)
);
create index patient_records_org_idx on clinical_core.patient_records(organization_id);

create table clinical_core.patient_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  patient_record_id uuid not null,
  consumer_person_id uuid references clinical_core.persons(id),
  state text not null default 'invitation_pending'
    check (state in ('invitation_pending','verified','paused','revoked')),
  verified_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (patient_record_id, organization_id)
    references clinical_core.patient_records(id, organization_id),
  unique (id, organization_id, patient_record_id),
  check (
    (state = 'invitation_pending' and consumer_person_id is null and verified_at is null)
    or (state in ('verified','paused') and consumer_person_id is not null and verified_at is not null)
    or state = 'revoked'
  )
);
create unique index patient_connections_live_patient_uniq
  on clinical_core.patient_connections(organization_id, patient_record_id)
  where state <> 'revoked';
create unique index patient_connections_live_consumer_uniq
  on clinical_core.patient_connections(consumer_person_id)
  where consumer_person_id is not null and state <> 'revoked';
create index patient_connections_org_idx on clinical_core.patient_connections(organization_id);
create index patient_connections_patient_idx on clinical_core.patient_connections(patient_record_id);
create index patient_connections_consumer_idx on clinical_core.patient_connections(consumer_person_id);

create table clinical_core.connection_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null references clinical_core.patient_records(id),
  connection_id uuid not null references clinical_core.patient_connections(id),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9:_-]{8,128}$'),
  status text not null default 'pending'
    check (status in ('pending','accepted','expired','superseded','revoked')),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  created_by_person_id uuid not null references clinical_core.persons(id),
  unique (organization_id, idempotency_key),
  foreign key (connection_id, organization_id, patient_record_id)
    references clinical_core.patient_connections(id, organization_id, patient_record_id),
  check ((status = 'accepted' and used_at is not null)
    or (status <> 'accepted' and used_at is null))
);
create index connection_invitations_connection_idx
  on clinical_core.connection_invitations(connection_id);
create index connection_invitations_patient_idx
  on clinical_core.connection_invitations(patient_record_id);
create index connection_invitations_org_idx
  on clinical_core.connection_invitations(organization_id);
create index connection_invitations_created_by_idx
  on clinical_core.connection_invitations(created_by_person_id);

create table clinical_core.consent_artifacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  scope text not null check (scope in (
    'programs','protocols_supplements','nutrition','appointments','messaging',
    'forms_checkins','symptoms_adherence','wearables','lab_summaries',
    'billing_links','research_n_of_1')),
  artifact_version text not null check (char_length(artifact_version) between 1 and 64),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  jurisdiction text not null check (char_length(jurisdiction) between 2 and 64),
  status text not null check (status in ('draft','approved','retired')),
  approved_at timestamptz,
  approved_by_person_id uuid references clinical_core.persons(id),
  created_at timestamptz not null default clock_timestamp(),
  unique (organization_id, scope, artifact_version),
  unique (id, organization_id),
  check ((status = 'draft' and approved_at is null and approved_by_person_id is null)
    or (status in ('approved','retired') and approved_at is not null and approved_by_person_id is not null))
);
create index consent_artifacts_org_idx on clinical_core.consent_artifacts(organization_id);
create index consent_artifacts_approved_by_idx
  on clinical_core.consent_artifacts(approved_by_person_id);

create table clinical_core.consent_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  patient_record_id uuid not null references clinical_core.patient_records(id),
  connection_id uuid not null references clinical_core.patient_connections(id),
  artifact_id uuid references clinical_core.consent_artifacts(id),
  scope text not null check (scope in (
    'programs','protocols_supplements','nutrition','appointments','messaging',
    'forms_checkins','symptoms_adherence','wearables','lab_summaries',
    'billing_links','research_n_of_1')),
  status text not null check (status in ('granted','revoked')),
  method text not null check (method in ('patient_app','portal','in_person','written')),
  representative_authority text not null
    check (representative_authority in ('self','guardian','healthcare_proxy','legal_representative')),
  reason_code text check (reason_code in ('patient_request','scope_changed','connection_revoked')),
  version integer not null check (version > 0),
  recorded_at timestamptz not null default clock_timestamp(),
  recorded_by_person_id uuid not null references clinical_core.persons(id),
  foreign key (connection_id, organization_id, patient_record_id)
    references clinical_core.patient_connections(id, organization_id, patient_record_id),
  foreign key (artifact_id, organization_id)
    references clinical_core.consent_artifacts(id, organization_id),
  check ((status = 'granted' and artifact_id is not null and reason_code is null)
    or (status = 'revoked' and artifact_id is null and reason_code is not null)),
  unique (connection_id, scope, version)
);
create index consent_grants_org_idx on clinical_core.consent_grants(organization_id);
create index consent_grants_patient_idx on clinical_core.consent_grants(patient_record_id);
create index consent_grants_connection_scope_idx
  on clinical_core.consent_grants(connection_id, scope, version desc);
create index consent_grants_artifact_idx on clinical_core.consent_grants(artifact_id);
create index consent_grants_recorded_by_idx on clinical_core.consent_grants(recorded_by_person_id);

create table clinical_audit.events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references clinical_core.organizations(id),
  actor_person_id uuid not null references clinical_core.persons(id),
  action text not null check (action in (
    'connection.invitation_issued','connection.invitation_claimed',
    'consent.granted','consent.revoked')),
  resource_type text not null check (resource_type in ('connection','consent')),
  resource_id uuid not null,
  purpose text not null check (purpose in ('identity_link','consent_management')),
  safe_metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default clock_timestamp(),
  check (jsonb_typeof(safe_metadata) = 'object'),
  check (not (safe_metadata ?| array[
    'email','name','phone','date_of_birth','dob','token','token_hash',
    'raw_reason','authorization','cookie','payload']))
);
create index audit_events_org_time_idx
  on clinical_audit.events(organization_id, occurred_at desc);
create index audit_events_actor_idx on clinical_audit.events(actor_person_id);

create or replace function clinical_private.claim(_name text)
returns text language sql stable security invoker set search_path = '' as $$
  select nullif(current_setting('clinical.claim.' || _name, true), '')
$$;

create or replace function clinical_private.actor_person_id()
returns uuid language sql stable security invoker set search_path = '' as $$
  select clinical_private.claim('actor_person_id')::uuid
$$;

create or replace function clinical_private.organization_id()
returns uuid language sql stable security invoker set search_path = '' as $$
  select clinical_private.claim('organization_id')::uuid
$$;

create or replace function clinical_private.is_active_member(_organization_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from clinical_core.organization_memberships m
    where m.organization_id = _organization_id
      and m.person_id = clinical_private.actor_person_id()
      and m.status = 'active'
  )
$$;

create or replace function clinical_private.has_clinical_role(_organization_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from clinical_core.organization_memberships m
    where m.organization_id = _organization_id
      and m.person_id = clinical_private.actor_person_id()
      and m.status = 'active'
      and m.role in ('owner','admin','practitioner')
  )
$$;

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
    or _purpose not in ('identity_link','consent_management')
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

create or replace function clinical_private.assert_synthetic_context(
  _organization_id uuid,
  _purpose text,
  _required_pool text default null
)
returns void language plpgsql stable security invoker set search_path = '' as $$
begin
  if clinical_private.claim('environment') <> 'synthetic-staging'
    or clinical_private.claim('data_classification') <> 'synthetic_only'
    or clinical_private.organization_id() <> _organization_id
    or clinical_private.claim('purpose') <> _purpose
    or (_required_pool is not null and clinical_private.claim('identity_pool') <> _required_pool) then
    raise exception using errcode = '42501', message = 'synthetic_context_refused';
  end if;
end
$$;

create or replace function clinical_private.block_update_delete()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  raise exception using errcode = '55000', message = 'append_only_record';
end
$$;

create trigger consent_grants_append_only
  before update or delete on clinical_core.consent_grants
  for each row execute function clinical_private.block_update_delete();
create trigger audit_events_append_only
  before update or delete on clinical_audit.events
  for each row execute function clinical_private.block_update_delete();

create or replace function clinical_private.protect_invitation_identity()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.organization_id <> old.organization_id
    or new.patient_record_id <> old.patient_record_id
    or new.connection_id <> old.connection_id
    or new.token_hash <> old.token_hash
    or new.idempotency_key <> old.idempotency_key
    or new.created_by_person_id <> old.created_by_person_id
    or new.created_at <> old.created_at then
    raise exception using errcode = '55000', message = 'invitation_identity_immutable';
  end if;
  return new;
end
$$;
create trigger invitation_identity_immutable
  before update on clinical_core.connection_invitations
  for each row execute function clinical_private.protect_invitation_identity();
create trigger invitations_no_delete
  before delete on clinical_core.connection_invitations
  for each row execute function clinical_private.block_update_delete();

create or replace function clinical_core.issue_connection_invitation(
  _organization_id uuid,
  _patient_record_id uuid,
  _token_hash text,
  _expires_at timestamptz,
  _idempotency_key text
)
returns table(invitation_id uuid, connection_id uuid, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  _connection_id uuid;
  _invitation_id uuid;
  _existing clinical_core.connection_invitations%rowtype;
begin
  perform clinical_private.assert_synthetic_context(_organization_id, 'identity_link', 'workforce');
  if not clinical_private.has_clinical_role(_organization_id) then
    raise exception using errcode = '42501', message = 'clinical_role_required';
  end if;
  if _token_hash !~ '^[0-9a-f]{64}$'
    or _expires_at <= clock_timestamp()
    or _expires_at > clock_timestamp() + interval '48 hours' then
    raise exception using errcode = '22023', message = 'invitation_shape_invalid';
  end if;
  if not exists (
    select 1 from clinical_core.patient_records p
    where p.id = _patient_record_id and p.organization_id = _organization_id
      and p.status = 'active' and p.contains_phi = false
  ) then
    raise exception using errcode = 'P0002', message = 'synthetic_patient_not_found';
  end if;

  select * into _existing from clinical_core.connection_invitations i
  where i.organization_id = _organization_id and i.idempotency_key = _idempotency_key;
  if found then
    if _existing.patient_record_id <> _patient_record_id
      or _existing.token_hash <> _token_hash
      or _existing.expires_at <> _expires_at then
      raise exception using errcode = '40001', message = 'idempotency_conflict';
    end if;
    return query select _existing.id, _existing.connection_id, _existing.expires_at;
    return;
  end if;

  select c.id into _connection_id from clinical_core.patient_connections c
  where c.organization_id = _organization_id
    and c.patient_record_id = _patient_record_id
    and c.state <> 'revoked'
  for update;
  if _connection_id is not null and exists (
    select 1 from clinical_core.patient_connections c
    where c.id = _connection_id and c.state <> 'invitation_pending'
  ) then
    raise exception using errcode = '55000', message = 'connection_not_invitable';
  end if;
  if _connection_id is null then
    insert into clinical_core.patient_connections(organization_id, patient_record_id)
    values (_organization_id, _patient_record_id)
    returning id into _connection_id;
  end if;

  update clinical_core.connection_invitations
  set status = 'superseded'
  where connection_id = _connection_id and status = 'pending';

  insert into clinical_core.connection_invitations(
    organization_id, patient_record_id, connection_id, token_hash,
    idempotency_key, expires_at, created_by_person_id
  ) values (
    _organization_id, _patient_record_id, _connection_id, _token_hash,
    _idempotency_key, _expires_at, clinical_private.actor_person_id()
  ) returning id into _invitation_id;

  insert into clinical_audit.events(
    organization_id, actor_person_id, action, resource_type, resource_id, purpose,
    safe_metadata
  ) values (
    _organization_id, clinical_private.actor_person_id(),
    'connection.invitation_issued', 'connection', _connection_id, 'identity_link',
    jsonb_build_object('invitation_id', _invitation_id)
  );
  return query select _invitation_id, _connection_id, _expires_at;
end
$$;

create or replace function clinical_core.claim_connection_invitation(
  _token_hash text,
  _consumer_person_id uuid
)
returns table(
  connection_id uuid, patient_record_id uuid, consumer_person_id uuid,
  state text, verified_at timestamptz
)
language plpgsql security definer set search_path = '' as $$
declare
  _invitation clinical_core.connection_invitations%rowtype;
  _verified_at timestamptz := clock_timestamp();
begin
  if clinical_private.actor_person_id() <> _consumer_person_id
    or clinical_private.claim('identity_pool') <> 'consumer'
    or clinical_private.claim('purpose') <> 'identity_link'
    or clinical_private.claim('environment') <> 'synthetic-staging'
    or clinical_private.claim('data_classification') <> 'synthetic_only' then
    raise exception using errcode = '42501', message = 'consumer_identity_required';
  end if;
  select * into _invitation from clinical_core.connection_invitations i
  where i.token_hash = _token_hash for update;
  if not found or _invitation.status <> 'pending' or _invitation.expires_at <= _verified_at then
    raise exception using errcode = 'P0002', message = 'invitation_invalid_or_expired';
  end if;
  perform clinical_private.assert_synthetic_context(_invitation.organization_id, 'identity_link', 'consumer');

  update clinical_core.patient_connections
  set consumer_person_id = _consumer_person_id,
      state = 'verified', verified_at = _verified_at, updated_at = _verified_at
  where id = _invitation.connection_id and state = 'invitation_pending';
  if not found then
    raise exception using errcode = '55000', message = 'connection_not_claimable';
  end if;
  update clinical_core.connection_invitations
  set status = 'accepted', used_at = _verified_at where id = _invitation.id;
  update clinical_core.connection_invitations
  set status = 'superseded'
  where connection_id = _invitation.connection_id and status = 'pending' and id <> _invitation.id;

  insert into clinical_audit.events(
    organization_id, actor_person_id, action, resource_type, resource_id, purpose
  ) values (
    _invitation.organization_id, _consumer_person_id,
    'connection.invitation_claimed', 'connection', _invitation.connection_id, 'identity_link'
  );
  return query select _invitation.connection_id, _invitation.patient_record_id,
    _consumer_person_id, 'verified'::text, _verified_at;
end
$$;

create or replace function clinical_core.record_consent_grant(
  _connection_id uuid,
  _artifact_id uuid,
  _scope text,
  _method text,
  _representative_authority text
)
returns table(
  consent_id uuid, connection_id uuid, scope text, status text,
  version integer, recorded_at timestamptz
)
language plpgsql security definer set search_path = '' as $$
declare
  _connection clinical_core.patient_connections%rowtype;
  _artifact clinical_core.consent_artifacts%rowtype;
  _version integer;
  _latest_status text;
  _id uuid;
  _at timestamptz := clock_timestamp();
begin
  select * into _connection from clinical_core.patient_connections c
  where c.id = _connection_id and c.state in ('verified','paused') for update;
  if not found then raise exception using errcode = 'P0002', message = 'connection_not_found'; end if;
  perform clinical_private.assert_synthetic_context(_connection.organization_id, 'consent_management', null);
  if not (
    (_connection.consumer_person_id = clinical_private.actor_person_id()
      and clinical_private.claim('identity_pool') = 'consumer')
    or (clinical_private.claim('identity_pool') = 'workforce'
      and clinical_private.has_clinical_role(_connection.organization_id))
  ) then
    raise exception using errcode = '42501', message = 'consent_actor_refused';
  end if;
  select * into _artifact from clinical_core.consent_artifacts a
  where a.id = _artifact_id and a.organization_id = _connection.organization_id
    and a.scope = _scope and a.status = 'approved';
  if not found then raise exception using errcode = '55000', message = 'approved_artifact_required'; end if;
  select g.status into _latest_status
  from clinical_core.consent_grants g
  where g.connection_id = _connection_id and g.scope = _scope
  order by g.version desc limit 1;
  if _latest_status = 'granted' then
    raise exception using errcode = '55000', message = 'consent_already_active';
  end if;
  select coalesce(max(g.version), 0) + 1 into _version
  from clinical_core.consent_grants g
  where g.connection_id = _connection_id and g.scope = _scope;
  insert into clinical_core.consent_grants(
    organization_id, patient_record_id, connection_id, artifact_id, scope,
    status, method, representative_authority, version, recorded_at,
    recorded_by_person_id
  ) values (
    _connection.organization_id, _connection.patient_record_id, _connection_id,
    _artifact_id, _scope, 'granted', _method, _representative_authority,
    _version, _at, clinical_private.actor_person_id()
  ) returning id into _id;
  insert into clinical_audit.events(
    organization_id, actor_person_id, action, resource_type, resource_id, purpose,
    safe_metadata
  ) values (
    _connection.organization_id, clinical_private.actor_person_id(),
    'consent.granted', 'consent', _id, 'consent_management',
    jsonb_build_object('scope', _scope, 'version', _version)
  );
  return query select _id, _connection_id, _scope, 'granted'::text, _version, _at;
end
$$;

create or replace function clinical_core.revoke_consent_grant(
  _connection_id uuid,
  _scope text,
  _reason_code text
)
returns table(
  consent_id uuid, connection_id uuid, scope text, status text,
  version integer, recorded_at timestamptz
)
language plpgsql security definer set search_path = '' as $$
declare
  _connection clinical_core.patient_connections%rowtype;
  _latest clinical_core.consent_grants%rowtype;
  _version integer;
  _id uuid;
  _at timestamptz := clock_timestamp();
begin
  select * into _connection from clinical_core.patient_connections c
  where c.id = _connection_id and c.state in ('verified','paused','revoked') for update;
  if not found then raise exception using errcode = 'P0002', message = 'connection_not_found'; end if;
  perform clinical_private.assert_synthetic_context(_connection.organization_id, 'consent_management', null);
  if not (
    (_connection.consumer_person_id = clinical_private.actor_person_id()
      and clinical_private.claim('identity_pool') = 'consumer')
    or (clinical_private.claim('identity_pool') = 'workforce'
      and clinical_private.has_clinical_role(_connection.organization_id))
  ) then
    raise exception using errcode = '42501', message = 'consent_actor_refused';
  end if;
  select * into _latest from clinical_core.consent_grants g
  where g.connection_id = _connection_id and g.scope = _scope
  order by g.version desc limit 1;
  if not found or _latest.status <> 'granted' then
    raise exception using errcode = '55000', message = 'active_consent_required';
  end if;
  _version := _latest.version + 1;
  insert into clinical_core.consent_grants(
    organization_id, patient_record_id, connection_id, artifact_id, scope,
    status, method, representative_authority, reason_code, version, recorded_at,
    recorded_by_person_id
  ) values (
    _connection.organization_id, _connection.patient_record_id, _connection_id,
    null, _scope, 'revoked', _latest.method, _latest.representative_authority,
    _reason_code, _version, _at, clinical_private.actor_person_id()
  ) returning id into _id;
  insert into clinical_audit.events(
    organization_id, actor_person_id, action, resource_type, resource_id, purpose,
    safe_metadata
  ) values (
    _connection.organization_id, clinical_private.actor_person_id(),
    'consent.revoked', 'consent', _id, 'consent_management',
    jsonb_build_object('scope', _scope, 'version', _version, 'reason_code', _reason_code)
  );
  return query select _id, _connection_id, _scope, 'revoked'::text, _version, _at;
end
$$;

create view clinical_core.current_consent with (
  security_barrier = true,
  security_invoker = true
) as
  select distinct on (g.connection_id, g.scope)
    g.id, g.organization_id, g.patient_record_id, g.connection_id, g.artifact_id,
    g.scope, g.status, g.method, g.representative_authority, g.reason_code,
    g.version, g.recorded_at, g.recorded_by_person_id
  from clinical_core.consent_grants g
  order by g.connection_id, g.scope, g.version desc;

alter table clinical_core.organizations enable row level security;
alter table clinical_core.persons enable row level security;
alter table clinical_core.identities enable row level security;
alter table clinical_core.organization_memberships enable row level security;
alter table clinical_core.patient_records enable row level security;
alter table clinical_core.patient_connections enable row level security;
alter table clinical_core.connection_invitations enable row level security;
alter table clinical_core.consent_artifacts enable row level security;
alter table clinical_core.consent_grants enable row level security;
alter table clinical_audit.events enable row level security;

create policy organizations_read on clinical_core.organizations for select
  using (clinical_private.is_active_member(id));
create policy persons_self_read on clinical_core.persons for select
  using (id = clinical_private.actor_person_id());
create policy identities_self_read on clinical_core.identities for select
  using (person_id = clinical_private.actor_person_id());
create policy memberships_read on clinical_core.organization_memberships for select
  using (organization_id = clinical_private.organization_id()
    and (person_id = clinical_private.actor_person_id()
      or clinical_private.has_clinical_role(organization_id)));
create policy patient_records_read on clinical_core.patient_records for select
  using (organization_id = clinical_private.organization_id()
    and (clinical_private.is_active_member(organization_id)
      or exists (
        select 1 from clinical_core.patient_connections c
        where c.patient_record_id = id
          and c.consumer_person_id = clinical_private.actor_person_id()
          and c.state in ('verified','paused')
      )));
create policy patient_connections_read on clinical_core.patient_connections for select
  using (organization_id = clinical_private.organization_id()
    and (clinical_private.is_active_member(organization_id)
      or consumer_person_id = clinical_private.actor_person_id()));
create policy consent_artifacts_read on clinical_core.consent_artifacts for select
  using (organization_id = clinical_private.organization_id()
    and status = 'approved'
    and (clinical_private.is_active_member(organization_id)
      or exists (
        select 1 from clinical_core.patient_connections c
        where c.organization_id = consent_artifacts.organization_id
          and c.consumer_person_id = clinical_private.actor_person_id()
          and c.state in ('verified','paused')
      )));
create policy consent_grants_read on clinical_core.consent_grants for select
  using (organization_id = clinical_private.organization_id()
    and (clinical_private.is_active_member(organization_id)
      or exists (
        select 1 from clinical_core.patient_connections c
        where c.id = connection_id
          and c.consumer_person_id = clinical_private.actor_person_id()
      )));
create policy audit_events_read on clinical_audit.events for select
  using (organization_id = clinical_private.organization_id()
    and clinical_private.has_clinical_role(organization_id));
-- Deliberately no direct-read policy for connection_invitations.

grant select on clinical_core.organizations, clinical_core.persons,
  clinical_core.identities, clinical_core.organization_memberships,
  clinical_core.patient_records, clinical_core.patient_connections,
  clinical_core.consent_artifacts, clinical_core.consent_grants,
  clinical_core.current_consent to clinical_core_api;
grant select on clinical_audit.events to clinical_core_api;

grant usage on schema clinical_core, clinical_private, clinical_audit
  to clinical_core_migrator;
grant all privileges on all tables in schema clinical_core, clinical_audit
  to clinical_core_migrator;
grant execute on all functions in schema clinical_core, clinical_private
  to clinical_core_migrator;

grant execute on function clinical_private.set_request_context(
  uuid, uuid, text, text, text, text, text) to clinical_core_api;
grant execute on function clinical_private.claim(text),
  clinical_private.actor_person_id(),
  clinical_private.organization_id(),
  clinical_private.is_active_member(uuid),
  clinical_private.has_clinical_role(uuid),
  clinical_private.assert_synthetic_context(uuid, text, text)
  to clinical_core_api;
grant execute on function clinical_core.issue_connection_invitation(
  uuid, uuid, text, timestamptz, text) to clinical_core_api;
grant execute on function clinical_core.claim_connection_invitation(text, uuid)
  to clinical_core_api;
grant execute on function clinical_core.record_consent_grant(
  uuid, uuid, text, text, text) to clinical_core_api;
grant execute on function clinical_core.revoke_consent_grant(uuid, text, text)
  to clinical_core_api;

revoke all on clinical_core.connection_invitations from clinical_core_api;
revoke all on all tables in schema clinical_audit from public;
revoke all on all functions in schema clinical_private from public;
revoke all on all functions in schema clinical_core from public;
