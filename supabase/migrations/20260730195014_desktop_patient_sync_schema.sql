-- Clinical Runtime Phase 5: Patient Delivery & Synchronization Gateway (schema).
--
-- The DESKTOP side of the future AI Longevity Pro patient-app bridge:
-- explicit patient-app connections (never matched by email/name/phone/DOB),
-- independent versioned consent scopes, append-only outbound/inbound sync
-- events with idempotency + payload hashes, delivery attempts, dead letters,
-- cursors, conflicts, and resource acknowledgments.
--
-- Nothing here contacts AI Longevity Pro. No event can be marked delivered or
-- acknowledged except through the service_role worker boundary with provider
-- evidence. Without a registered 'alp_patient_sync' connector, export
-- queueing itself fails closed.

begin;

-- ---------------------------------------------------------------- helpers

-- Fixed vocabularies (checks, not enums, for forward-compatible ALTERs).
--   scopes: programs, protocols_supplements, nutrition, appointments,
--           messaging, forms_checkins, symptoms_adherence, wearables,
--           lab_summaries, billing_links, research_n_of_1
--   research_n_of_1 is CARE-SEPARATE: nothing may infer it from care scopes.

create or replace function private.sync_scope_valid(_scope text)
returns boolean language sql immutable security definer set search_path = ''
as $$
  select _scope in ('programs','protocols_supplements','nutrition','appointments',
    'messaging','forms_checkins','symptoms_adherence','wearables',
    'lab_summaries','billing_links','research_n_of_1');
$$;

-- Provider posture: an approved AI Longevity Pro sync provider is a CONNECTED
-- connector row of provider 'alp_patient_sync'. None exists in production —
-- registering one is a reviewed operational act, never an environment flag.
create or replace function private.sync_provider_configured(_organization_id uuid)
returns text language sql stable security definer set search_path = ''
as $$
  select c.provider
  from public.connectors c
  where c.organization_id = _organization_id
    and c.provider = 'alp_patient_sync'
    and c.sync_status = 'connected'
  limit 1;
$$;

-- Connection managers: owner/admin/practitioner (staff can read, not manage).
create or replace function private.can_manage_sync(_organization_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.organization_memberships m
    where m.organization_id = _organization_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and m.role in ('owner','admin','practitioner')
  );
$$;

-- ------------------------------------------------------------ connections

create table public.patient_app_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  patient_id uuid not null references public.patient_profiles(id),
  external_system text not null default 'alp' check (external_system in ('alp')),
  -- Set ONLY at verification, by the worker boundary, from the external
  -- system's authenticated subject. Never derived from email/name/phone/DOB.
  external_subject_id text,
  state text not null default 'invitation_pending'
    check (state in ('invitation_pending','verified','paused','revoked','failed')),
  contract_version text not null default 'patient-sync/1',
  verified_at timestamptz,
  paused_at timestamptz,
  revoked_at timestamptz,
  revoke_reason_safe text,
  failed_reason_safe text,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  constraint verified_needs_subject
    check (state <> 'verified' or external_subject_id is not null)
);

-- One live (non-revoked) connection per patient per external system.
create unique index patient_app_connections_live_uniq
  on public.patient_app_connections (organization_id, patient_id, external_system)
  where state <> 'revoked';

-- One external subject can bind to at most one live connection — a forged or
-- reused subject is refused by this constraint, not by application code.
create unique index patient_app_connections_subject_uniq
  on public.patient_app_connections (external_system, external_subject_id)
  where external_subject_id is not null and state <> 'revoked';

create index patient_app_connections_patient_idx
  on public.patient_app_connections (patient_id);
create index patient_app_connections_org_state_idx
  on public.patient_app_connections (organization_id, state);
create index patient_app_connections_created_by_idx
  on public.patient_app_connections (created_by);
create index patient_app_connections_updated_by_idx
  on public.patient_app_connections (updated_by);

-- ------------------------------------------------------------ invitations

-- Opaque connection invitations. The raw token is returned ONCE by the
-- creating RPC and never stored — only its sha256. Single-use, expiring,
-- organization/patient scoped.
create table public.patient_sync_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  patient_id uuid not null references public.patient_profiles(id),
  connection_id uuid not null references public.patient_app_connections(id),
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

create index patient_sync_invitations_connection_idx
  on public.patient_sync_invitations (connection_id);
create index patient_sync_invitations_patient_idx
  on public.patient_sync_invitations (patient_id);
create index patient_sync_invitations_org_idx
  on public.patient_sync_invitations (organization_id);
create index patient_sync_invitations_created_by_idx
  on public.patient_sync_invitations (created_by);

-- --------------------------------------------------------- consent scopes

create table public.sync_consent_scopes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  patient_id uuid not null references public.patient_profiles(id),
  connection_id uuid not null references public.patient_app_connections(id),
  scope text not null,
  status text not null default 'granted' check (status in ('granted','revoked')),
  -- The exact consent artifact presented, and how.
  artifact_title text not null,
  artifact_version text not null,
  jurisdiction text,
  method text not null check (method in
    ('in_person','patient_app','portal','verbal_documented','written')),
  representative_authority text not null default 'self'
    check (representative_authority in ('self','guardian','healthcare_proxy','legal_representative')),
  granted_at timestamptz not null default now(),
  granted_by uuid references auth.users(id),
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id),
  revoke_source text check (revoke_source in ('practitioner','patient_app')),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sync_scope_known check (private.sync_scope_valid(scope)),
  constraint revoked_fields check (
    (status = 'granted' and revoked_at is null)
    or (status = 'revoked' and revoked_at is not null))
);

-- One ACTIVE grant per scope per connection; re-granting after revocation
-- appends a new row (history preserved).
create unique index sync_consent_scopes_active_uniq
  on public.sync_consent_scopes (connection_id, scope)
  where status = 'granted';

create index sync_consent_scopes_connection_idx on public.sync_consent_scopes (connection_id);
create index sync_consent_scopes_patient_idx on public.sync_consent_scopes (patient_id);
create index sync_consent_scopes_org_idx on public.sync_consent_scopes (organization_id);
create index sync_consent_scopes_granted_by_idx on public.sync_consent_scopes (granted_by);
create index sync_consent_scopes_revoked_by_idx on public.sync_consent_scopes (revoked_by);

-- -------------------------------------------------------- outbound events

create table public.sync_outbound_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  connection_id uuid not null references public.patient_app_connections(id),
  patient_id uuid not null references public.patient_profiles(id),
  contract_version text not null default 'patient-sync/1',
  event_uid uuid not null unique default gen_random_uuid(),
  idempotency_key text not null unique,
  scope text not null,
  resource_type text not null check (resource_type in
    ('program_enrollment','protocol_version','nutrition_plan',
     'supplement_instructions','appointment_summary','message',
     'checkin_assignment','lab_summary','resource_withdrawal')),
  resource_id uuid not null,
  resource_version text not null,
  occurred_at timestamptz not null default now(),
  producer text not null default 'desktop',
  provenance jsonb not null default '{}'::jsonb,
  -- Minimum-necessary payload, built SERVER-side — never caller-provided.
  payload jsonb not null,
  payload_hash text not null,
  correlation_id uuid,
  causation_id uuid,
  state text not null default 'queued' check (state in
    ('queued','sending','delivered','acknowledged','failed','dead_letter','superseded','cancelled')),
  attempts integer not null default 0,
  next_retry_at timestamptz,
  last_error_safe text,
  delivered_at timestamptz,
  acknowledged_at timestamptz,
  ack_provider_event_id text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  constraint sync_out_scope_known check (private.sync_scope_valid(scope))
);

create index sync_outbound_events_connection_state_idx
  on public.sync_outbound_events (connection_id, state);
create index sync_outbound_events_org_state_idx
  on public.sync_outbound_events (organization_id, state);
create index sync_outbound_events_patient_idx on public.sync_outbound_events (patient_id);
create index sync_outbound_events_resource_idx
  on public.sync_outbound_events (resource_type, resource_id);
create index sync_outbound_events_created_by_idx on public.sync_outbound_events (created_by);
create index sync_outbound_events_correlation_idx on public.sync_outbound_events (correlation_id);

-- Event CONTENT is append-only: once queued, the envelope never changes.
-- Only delivery-state fields may move, and only forward.
create or replace function private.guard_sync_outbound_mutation()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'sync events are append-only; deletion is not allowed'
      using errcode = '42501';
  end if;
  if new.payload is distinct from old.payload
     or new.payload_hash is distinct from old.payload_hash
     or new.resource_type is distinct from old.resource_type
     or new.resource_id is distinct from old.resource_id
     or new.resource_version is distinct from old.resource_version
     or new.scope is distinct from old.scope
     or new.event_uid is distinct from old.event_uid
     or new.idempotency_key is distinct from old.idempotency_key
     or new.contract_version is distinct from old.contract_version
     or new.connection_id is distinct from old.connection_id
     or new.organization_id is distinct from old.organization_id
     or new.patient_id is distinct from old.patient_id
     or new.occurred_at is distinct from old.occurred_at
     or new.producer is distinct from old.producer
     or new.provenance is distinct from old.provenance then
    raise exception 'a queued sync envelope is immutable; only delivery state may change'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger sync_outbound_events_guard
  before update or delete on public.sync_outbound_events
  for each row execute function private.guard_sync_outbound_mutation();

-- --------------------------------------------------------- inbound events

create table public.sync_inbound_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  connection_id uuid not null references public.patient_app_connections(id),
  patient_id uuid not null references public.patient_profiles(id),
  contract_version text not null,
  provider_event_id text not null,
  idempotency_key text not null unique,
  scope text not null,
  resource_type text not null check (resource_type in
    ('program_progress','quiz_response','checkin_response','protocol_adherence',
     'supplement_adherence','symptom_report','outcome_report','wearable_summary',
     'patient_message','appointment_request','consent_change',
     'delivery_receipt','read_receipt')),
  external_resource_id text,
  resource_version text,
  occurred_at timestamptz not null,
  -- THE ORIGINAL PATIENT SUBMISSION. Never mutated; corrections are overlays.
  payload jsonb not null,
  payload_hash text not null,
  signature_key_id text,
  correlation_id uuid,
  causation_id uuid,
  state text not null default 'received' check (state in
    ('received','processed','review_pending','conflict','rejected')),
  rejection_reason_safe text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  review_note text,
  constraint sync_in_scope_known check (private.sync_scope_valid(scope))
);

-- Provider replays are refused per connection.
create unique index sync_inbound_events_provider_uniq
  on public.sync_inbound_events (connection_id, provider_event_id);
create index sync_inbound_events_connection_state_idx
  on public.sync_inbound_events (connection_id, state);
create index sync_inbound_events_org_state_idx
  on public.sync_inbound_events (organization_id, state);
create index sync_inbound_events_patient_idx on public.sync_inbound_events (patient_id);
create index sync_inbound_events_reviewed_by_idx on public.sync_inbound_events (reviewed_by);

create or replace function private.guard_sync_inbound_mutation()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'inbound sync events are append-only; deletion is not allowed'
      using errcode = '42501';
  end if;
  if new.payload is distinct from old.payload
     or new.payload_hash is distinct from old.payload_hash
     or new.provider_event_id is distinct from old.provider_event_id
     or new.occurred_at is distinct from old.occurred_at
     or new.resource_type is distinct from old.resource_type
     or new.scope is distinct from old.scope
     or new.connection_id is distinct from old.connection_id
     or new.organization_id is distinct from old.organization_id
     or new.patient_id is distinct from old.patient_id
     or new.contract_version is distinct from old.contract_version then
    raise exception 'an inbound patient submission is immutable; corrections are overlays'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger sync_inbound_events_guard
  before update or delete on public.sync_inbound_events
  for each row execute function private.guard_sync_inbound_mutation();

-- Versioned correction overlays over inbound submissions. Append-only.
create table public.sync_inbound_corrections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  inbound_event_id uuid not null references public.sync_inbound_events(id),
  version integer not null,
  overlay jsonb not null,
  reason text not null,
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  unique (inbound_event_id, version)
);

create index sync_inbound_corrections_org_idx on public.sync_inbound_corrections (organization_id);
create index sync_inbound_corrections_created_by_idx on public.sync_inbound_corrections (created_by);

create trigger sync_inbound_corrections_guard
  before update or delete on public.sync_inbound_corrections
  for each row execute function private.forbid_mutation();

-- ------------------------------------------------------ delivery attempts

create table public.sync_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  outbound_event_id uuid not null references public.sync_outbound_events(id),
  attempt_no integer not null,
  outcome text not null check (outcome in
    ('sent','delivered','failed','provider_error','refused_no_provider',
     'refused_revoked','refused_consent')),
  provider_message_id text,
  provider_event_id text,
  error_safe text,
  created_at timestamptz not null default now(),
  unique (outbound_event_id, attempt_no)
);

create index sync_delivery_attempts_org_idx on public.sync_delivery_attempts (organization_id);

create trigger sync_delivery_attempts_guard
  before update or delete on public.sync_delivery_attempts
  for each row execute function private.forbid_mutation();

-- Delivery/ack evidence from the provider; unique per provider event id so
-- duplicate callbacks are refused, not double-applied.
create table public.sync_delivery_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  connection_id uuid not null references public.patient_app_connections(id),
  outbound_event_id uuid not null references public.sync_outbound_events(id),
  provider_event_id text not null,
  kind text not null check (kind in ('delivered','acknowledged','failed','rejected')),
  occurred_at timestamptz not null,
  signature_key_id text,
  error_safe text,
  created_at timestamptz not null default now(),
  unique (connection_id, provider_event_id)
);

create index sync_delivery_events_outbound_idx on public.sync_delivery_events (outbound_event_id);
create index sync_delivery_events_org_idx on public.sync_delivery_events (organization_id);

create trigger sync_delivery_events_guard
  before update or delete on public.sync_delivery_events
  for each row execute function private.forbid_mutation();

-- ------------------------------------------------------------ dead letter

create table public.sync_dead_letters (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  outbound_event_id uuid not null unique references public.sync_outbound_events(id),
  reason_safe text not null,
  entered_at timestamptz not null default now(),
  retried_at timestamptz,
  retried_by uuid references auth.users(id),
  retry_reason text
);

create index sync_dead_letters_org_idx on public.sync_dead_letters (organization_id);
create index sync_dead_letters_retried_by_idx on public.sync_dead_letters (retried_by);

-- ---------------------------------------------------------------- cursors

create table public.sync_cursors (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  connection_id uuid not null references public.patient_app_connections(id),
  direction text not null check (direction in ('outbound','inbound')),
  scope text not null,
  position_at timestamptz not null,
  last_event_id uuid,
  updated_at timestamptz not null default now(),
  unique (connection_id, direction, scope),
  constraint sync_cursor_scope_known check (private.sync_scope_valid(scope))
);

create index sync_cursors_org_idx on public.sync_cursors (organization_id);

-- -------------------------------------------------------------- conflicts

create table public.sync_conflicts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  connection_id uuid not null references public.patient_app_connections(id),
  patient_id uuid not null references public.patient_profiles(id),
  scope text not null,
  resource_type text not null,
  resource_ref text not null,
  outbound_event_id uuid references public.sync_outbound_events(id),
  inbound_event_id uuid references public.sync_inbound_events(id),
  desktop_version text,
  external_version text,
  reason_safe text not null,
  state text not null default 'open' check (state in
    ('open','resolved_keep_desktop','resolved_keep_external','resolved_manual','dismissed')),
  resolution_note text,
  resolved_by uuid references auth.users(id),
  resolved_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now()
);

create index sync_conflicts_connection_state_idx on public.sync_conflicts (connection_id, state);
create index sync_conflicts_org_state_idx on public.sync_conflicts (organization_id, state);
create index sync_conflicts_patient_idx on public.sync_conflicts (patient_id);
create index sync_conflicts_outbound_idx on public.sync_conflicts (outbound_event_id);
create index sync_conflicts_inbound_idx on public.sync_conflicts (inbound_event_id);
create index sync_conflicts_resolved_by_idx on public.sync_conflicts (resolved_by);

-- ------------------------------------------------- resource acknowledgment

-- The per-resource projection powering resource-level sync status in the UI.
create table public.sync_resource_acks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  connection_id uuid not null references public.patient_app_connections(id),
  scope text not null,
  resource_type text not null,
  resource_id uuid not null,
  resource_version text not null,
  state text not null default 'pending' check (state in
    ('pending','delivered','acknowledged','failed','withdrawn')),
  last_outbound_event_id uuid references public.sync_outbound_events(id),
  acknowledged_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (connection_id, resource_type, resource_id)
);

create index sync_resource_acks_org_idx on public.sync_resource_acks (organization_id);
create index sync_resource_acks_last_event_idx on public.sync_resource_acks (last_outbound_event_id);

-- ------------------------------------------------------ connection history

create table public.sync_connection_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  connection_id uuid not null references public.patient_app_connections(id),
  kind text not null,
  from_value text,
  to_value text,
  note text,
  actor_user_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index sync_connection_events_connection_idx
  on public.sync_connection_events (connection_id, created_at);
create index sync_connection_events_org_idx on public.sync_connection_events (organization_id);
create index sync_connection_events_actor_idx on public.sync_connection_events (actor_user_id);

create trigger sync_connection_events_guard
  before update or delete on public.sync_connection_events
  for each row execute function private.forbid_mutation();

-- ------------------------------------------------------------------- RLS

alter table public.patient_app_connections enable row level security;
alter table public.patient_sync_invitations enable row level security;
alter table public.sync_consent_scopes enable row level security;
alter table public.sync_outbound_events enable row level security;
alter table public.sync_inbound_events enable row level security;
alter table public.sync_inbound_corrections enable row level security;
alter table public.sync_delivery_attempts enable row level security;
alter table public.sync_delivery_events enable row level security;
alter table public.sync_dead_letters enable row level security;
alter table public.sync_cursors enable row level security;
alter table public.sync_conflicts enable row level security;
alter table public.sync_resource_acks enable row level security;
alter table public.sync_connection_events enable row level security;

-- Reads: org members with access to the patient. Writes: NONE directly —
-- every mutation goes through a definer RPC.
create policy sync_connections_select on public.patient_app_connections
  for select to authenticated
  using (private.is_org_member(organization_id) and private.can_access_patient(patient_id));
create policy sync_consents_select on public.sync_consent_scopes
  for select to authenticated
  using (private.is_org_member(organization_id) and private.can_access_patient(patient_id));
create policy sync_outbound_select on public.sync_outbound_events
  for select to authenticated
  using (private.is_org_member(organization_id) and private.can_access_patient(patient_id));
create policy sync_inbound_select on public.sync_inbound_events
  for select to authenticated
  using (private.is_org_member(organization_id) and private.can_access_patient(patient_id));
create policy sync_corrections_select on public.sync_inbound_corrections
  for select to authenticated
  using (private.is_org_member(organization_id));
create policy sync_attempts_select on public.sync_delivery_attempts
  for select to authenticated
  using (private.is_org_member(organization_id));
create policy sync_delivery_events_select on public.sync_delivery_events
  for select to authenticated
  using (private.is_org_member(organization_id));
create policy sync_dead_letters_select on public.sync_dead_letters
  for select to authenticated
  using (private.is_org_member(organization_id));
create policy sync_cursors_select on public.sync_cursors
  for select to authenticated
  using (private.is_org_member(organization_id));
create policy sync_conflicts_select on public.sync_conflicts
  for select to authenticated
  using (private.is_org_member(organization_id) and private.can_access_patient(patient_id));
create policy sync_resource_acks_select on public.sync_resource_acks
  for select to authenticated
  using (private.is_org_member(organization_id));
create policy sync_connection_events_select on public.sync_connection_events
  for select to authenticated
  using (private.is_org_member(organization_id));
-- patient_sync_invitations: NO select policy — token hashes never leave the
-- database; invitation facts are surfaced through RPC projections only.

revoke all on public.patient_app_connections from anon, public;
revoke all on public.patient_sync_invitations from anon, public, authenticated;
revoke all on public.sync_consent_scopes from anon, public;
revoke all on public.sync_outbound_events from anon, public;
revoke all on public.sync_inbound_events from anon, public;
revoke all on public.sync_inbound_corrections from anon, public;
revoke all on public.sync_delivery_attempts from anon, public;
revoke all on public.sync_delivery_events from anon, public;
revoke all on public.sync_dead_letters from anon, public;
revoke all on public.sync_cursors from anon, public;
revoke all on public.sync_conflicts from anon, public;
revoke all on public.sync_resource_acks from anon, public;
revoke all on public.sync_connection_events from anon, public;

-- Authenticated: SELECT only (RLS-scoped). All writes revoked.
grant select on public.patient_app_connections to authenticated;
grant select on public.sync_consent_scopes to authenticated;
grant select on public.sync_outbound_events to authenticated;
grant select on public.sync_inbound_events to authenticated;
grant select on public.sync_inbound_corrections to authenticated;
grant select on public.sync_delivery_attempts to authenticated;
grant select on public.sync_delivery_events to authenticated;
grant select on public.sync_dead_letters to authenticated;
grant select on public.sync_cursors to authenticated;
grant select on public.sync_conflicts to authenticated;
grant select on public.sync_resource_acks to authenticated;
grant select on public.sync_connection_events to authenticated;
revoke insert, update, delete on public.patient_app_connections from authenticated;
revoke insert, update, delete on public.sync_consent_scopes from authenticated;
revoke insert, update, delete on public.sync_outbound_events from authenticated;
revoke insert, update, delete on public.sync_inbound_events from authenticated;
revoke insert, update, delete on public.sync_inbound_corrections from authenticated;
revoke insert, update, delete on public.sync_delivery_attempts from authenticated;
revoke insert, update, delete on public.sync_delivery_events from authenticated;
revoke insert, update, delete on public.sync_dead_letters from authenticated;
revoke insert, update, delete on public.sync_cursors from authenticated;
revoke insert, update, delete on public.sync_conflicts from authenticated;
revoke insert, update, delete on public.sync_resource_acks from authenticated;
revoke insert, update, delete on public.sync_connection_events from authenticated;

commit;
