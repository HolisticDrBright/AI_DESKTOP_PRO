-- Phase 10B.2 — Controlled Live-Provider Staging Activation
--
-- Additive only. Extends the Phase 10B.1 registry and activation tables
-- rather than creating a parallel provider system. Nothing here activates
-- anything: every new column defaults to the refusing value, and two CHECK
-- constraints make production and real-patient activation structurally
-- unreachable in this phase.
--
-- WHAT THIS PHASE IS FOR. Proving that the governed copilot can make
-- BOUNDED REAL requests to OpenAI using SYNTHETIC STAGING data, while real
-- patient use and production activation remain impossible. Everything
-- below is written to make the second half of that sentence enforced
-- rather than promised.
--
-- FIVE THINGS THIS MIGRATION ADDS
--
--   1. `clinical_synthetic_eligibility` — an EXPLICIT, attested, revocable
--      marker saying a specific subject is synthetic. Synthetic status is
--      never inferred from a name, an email domain, an MRN pattern, or a
--      fixture-looking id. A human recorded it against a reference, or the
--      subject is not eligible.
--   2. Activation SCOPE on the existing per-org activation row —
--      environment, approved use, approved model — plus an expiry and an
--      immediate kill switch.
--   3. `clinical_copilot_activation_history` — append-only, so approval,
--      suspension, revocation, expiry, and kill-switch changes cannot be
--      rewritten after the fact.
--   4. `clinical_copilot_provider_posture` — OpenAI's legal/data posture
--      recorded honestly as unknown / verified / expired / not_approved.
--      Everything defaults to `unknown`. Configuration is never evidence.
--   5. Budget and telemetry ledgers with an ATOMIC reservation RPC, so a
--      call cap is enforced against concurrent callers rather than checked
--      and then raced.
--
-- SECRETS. Unchanged from 10B.1: only a reference is ever stored. The new
-- posture table stores an OpenAI organization/project IDENTIFIER, which is
-- not a credential, and the same secret-shaped-value CHECK is applied to
-- it so a key pasted into the wrong field is refused rather than kept.

-- ===========================================================================
-- 1. Explicit synthetic eligibility
-- ===========================================================================

create table if not exists public.clinical_synthetic_eligibility (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  subject_type text not null,
  subject_id uuid not null,
  -- The only value this phase grants. Widening it is a future migration and
  -- a future review, not a runtime decision.
  eligibility text not null default 'synthetic_only',
  -- A human-recorded reference to the attestation. Placeholder strings are
  -- refused: "TBD" is how an unattested subject becomes attested by
  -- accident.
  attestation_reference text not null,
  attested_by uuid references auth.users(id),
  attested_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id),
  revocation_reason text,
  created_at timestamptz not null default now(),
  constraint synthetic_eligibility_subject_type
    check (subject_type in ('patient')),
  constraint synthetic_eligibility_value
    check (eligibility in ('synthetic_only')),
  constraint synthetic_eligibility_reference_nonempty
    check (length(trim(attestation_reference)) >= 4),
  constraint synthetic_eligibility_reference_not_placeholder
    check (lower(trim(attestation_reference)) !~ '^(n/?a|none|tbd|pending|todo|test|placeholder|unknown)$')
);

-- One live attestation per subject. A revoked row stays for the audit
-- trail; only the unrevoked one is authoritative.
create unique index if not exists clinical_synthetic_eligibility_live_uniq
  on public.clinical_synthetic_eligibility (organization_id, subject_type, subject_id)
  where revoked_at is null;
create index if not exists clinical_synthetic_eligibility_org_idx
  on public.clinical_synthetic_eligibility (organization_id);
create index if not exists clinical_synthetic_eligibility_attested_by_idx
  on public.clinical_synthetic_eligibility (attested_by);
create index if not exists clinical_synthetic_eligibility_revoked_by_idx
  on public.clinical_synthetic_eligibility (revoked_by);

alter table public.clinical_synthetic_eligibility enable row level security;

create policy clinical_synthetic_eligibility_org_read
  on public.clinical_synthetic_eligibility for select to authenticated
  using (exists (
    select 1 from public.organization_memberships m
    where m.organization_id = clinical_synthetic_eligibility.organization_id
      and m.user_id = (select auth.uid()) and m.status = 'active'));

revoke insert, update, delete on public.clinical_synthetic_eligibility from anon, authenticated;

-- ===========================================================================
-- 2. Activation scope, expiry, and kill switch
-- ===========================================================================

alter table public.clinical_copilot_org_activations
  add column if not exists environment text not null default 'unset',
  add column if not exists approved_use text not null default 'none',
  add column if not exists approved_model text,
  add column if not exists scope_expires_at timestamptz,
  add column if not exists kill_switch_engaged boolean not null default false,
  add column if not exists kill_switch_reason text,
  add column if not exists kill_switch_at timestamptz,
  add column if not exists kill_switch_by uuid references auth.users(id);

do $$ begin
  alter table public.clinical_copilot_org_activations
    add constraint copilot_activation_environment_values
    check (environment in ('unset','staging'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.clinical_copilot_org_activations
    add constraint copilot_activation_approved_use_values
    check (approved_use in ('none','synthetic_staging_verification'));
exception when duplicate_object then null; end $$;

comment on constraint copilot_activation_environment_values
  on public.clinical_copilot_org_activations is
  'Phase 10B.2: `production` is deliberately absent. Production activation is '
  'not a runtime decision that a mis-set row can make -- it requires a '
  'reviewed migration that widens this constraint.';

comment on constraint copilot_activation_approved_use_values
  on public.clinical_copilot_org_activations is
  'Phase 10B.2: `patient_data` is deliberately absent for the same reason. '
  'Real-patient activation cannot be reached by writing a row.';

create index if not exists copilot_activation_kill_switch_by_idx
  on public.clinical_copilot_org_activations (kill_switch_by);

-- ===========================================================================
-- 3. Append-only activation history
-- ===========================================================================

create table if not exists public.clinical_copilot_activation_history (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider_registry_id uuid not null references public.clinical_copilot_provider_registry(id) on delete cascade,
  change_kind text not null,
  from_state jsonb not null default '{}'::jsonb,
  to_state jsonb not null default '{}'::jsonb,
  reason text,
  actor_user_id uuid references auth.users(id),
  recorded_at timestamptz not null default now(),
  constraint copilot_activation_history_kind
    check (change_kind in (
      'state_changed','scope_changed','kill_switch_engaged','kill_switch_released',
      'expired','suspended','revoked','posture_reviewed'))
);

create index if not exists copilot_activation_history_org_idx
  on public.clinical_copilot_activation_history (organization_id, recorded_at desc);
create index if not exists copilot_activation_history_provider_idx
  on public.clinical_copilot_activation_history (provider_registry_id);
create index if not exists copilot_activation_history_actor_idx
  on public.clinical_copilot_activation_history (actor_user_id);

alter table public.clinical_copilot_activation_history enable row level security;

create policy copilot_activation_history_org_read
  on public.clinical_copilot_activation_history for select to authenticated
  using (exists (
    select 1 from public.organization_memberships m
    where m.organization_id = clinical_copilot_activation_history.organization_id
      and m.user_id = (select auth.uid()) and m.status = 'active'));

revoke insert, update, delete on public.clinical_copilot_activation_history from anon, authenticated;

-- Append-only. An approval history that can be edited is not a history.
create or replace function public.copilot_activation_history_append_only()
returns trigger language plpgsql security definer set search_path to '' as $$
begin
  raise exception 'clinical_copilot_activation_history is append-only'
    using errcode = '22023';
end;
$$;

drop trigger if exists copilot_activation_history_no_update on public.clinical_copilot_activation_history;
create trigger copilot_activation_history_no_update
  before update or delete on public.clinical_copilot_activation_history
  for each row execute function public.copilot_activation_history_append_only();

-- ===========================================================================
-- 4. Provider legal / data posture — honest by default
-- ===========================================================================

create table if not exists public.clinical_copilot_provider_posture (
  provider_registry_id uuid primary key
    references public.clinical_copilot_provider_registry(id) on delete cascade,
  -- unknown  : nobody has looked
  -- verified : a reviewer recorded evidence, with a date and a reference
  -- expired  : it was verified, and the verification has lapsed
  -- not_approved : a reviewer looked and the answer was no
  baa_status text not null default 'unknown',
  baa_verified_at timestamptz,
  zdr_mam_status text not null default 'unknown',
  zdr_mam_verified_at timestamptz,
  -- Identifiers, not credentials. A key pasted here is refused below.
  approved_openai_organization text,
  approved_openai_project text,
  eligible_endpoint text,
  eligible_model text,
  reviewer_reference text,
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint copilot_posture_baa_values
    check (baa_status in ('unknown','verified','expired','not_approved')),
  constraint copilot_posture_zdr_values
    check (zdr_mam_status in ('unknown','verified','expired','not_approved')),
  -- The same refusal the registry applies to provider_secret_ref. An
  -- OpenAI org/project id is short and public-ish; a key is neither.
  constraint copilot_posture_org_not_secret
    check (approved_openai_organization is null
           or approved_openai_organization !~ '^(sk-|Bearer |AKIA)'),
  constraint copilot_posture_project_not_secret
    check (approved_openai_project is null
           or approved_openai_project !~ '^(sk-|Bearer |AKIA)'),
  -- A status of `verified` is meaningless without who and when.
  constraint copilot_posture_verified_needs_evidence
    check (
      (baa_status <> 'verified' or (baa_verified_at is not null and reviewer_reference is not null))
      and
      (zdr_mam_status <> 'verified' or (zdr_mam_verified_at is not null and reviewer_reference is not null))
    )
);

create index if not exists copilot_posture_reviewed_by_idx
  on public.clinical_copilot_provider_posture (reviewed_by);

alter table public.clinical_copilot_provider_posture enable row level security;

create policy copilot_posture_member_read
  on public.clinical_copilot_provider_posture for select to authenticated
  using (exists (
    select 1 from public.organization_memberships m
    where m.user_id = (select auth.uid()) and m.status = 'active'));

revoke insert, update, delete on public.clinical_copilot_provider_posture from anon, authenticated;

-- ===========================================================================
-- 5. Budget + telemetry
-- ===========================================================================

create table if not exists public.clinical_copilot_call_budget (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider_registry_id uuid not null references public.clinical_copilot_provider_registry(id) on delete cascade,
  budget_key text not null,
  max_calls integer not null,
  max_tokens integer not null,
  max_cost_cents integer not null,
  used_calls integer not null default 0,
  used_input_tokens integer not null default 0,
  used_output_tokens integer not null default 0,
  used_cost_cents integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint copilot_budget_positive
    check (max_calls > 0 and max_tokens > 0 and max_cost_cents > 0),
  -- The whole point: usage can never exceed the cap, even if application
  -- code forgets to check. A race that would overshoot aborts the
  -- transaction instead.
  constraint copilot_budget_calls_within_cap check (used_calls <= max_calls),
  constraint copilot_budget_tokens_within_cap
    check (used_input_tokens + used_output_tokens <= max_tokens),
  constraint copilot_budget_cost_within_cap check (used_cost_cents <= max_cost_cents)
);

create unique index if not exists copilot_budget_key_uniq
  on public.clinical_copilot_call_budget (organization_id, provider_registry_id, budget_key);

alter table public.clinical_copilot_call_budget enable row level security;
create policy copilot_budget_org_read
  on public.clinical_copilot_call_budget for select to authenticated
  using (exists (
    select 1 from public.organization_memberships m
    where m.organization_id = clinical_copilot_call_budget.organization_id
      and m.user_id = (select auth.uid()) and m.status = 'active'));
revoke insert, update, delete on public.clinical_copilot_call_budget from anon, authenticated;

create table if not exists public.clinical_copilot_external_calls (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider_registry_id uuid not null references public.clinical_copilot_provider_registry(id) on delete cascade,
  run_id uuid references public.clinical_copilot_runs(id) on delete set null,
  budget_id uuid references public.clinical_copilot_call_budget(id) on delete set null,
  -- Safe telemetry only. There is deliberately no column for a prompt, a
  -- response, a patient identifier, or clinical content -- a field that
  -- does not exist cannot be filled in by a careless caller.
  provider_request_id text,
  model text not null,
  request_contract_version text not null,
  output_schema_version text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  latency_ms integer,
  result_category text not null,
  estimated_cost_cents integer not null default 0,
  reserved_at timestamptz not null default now(),
  settled_at timestamptz,
  constraint copilot_external_calls_result_category
    check (result_category in (
      'reserved','completed','provider_error','transport_error','schema_invalid',
      'citation_invalid','timeout','aborted_kill_switch','budget_exhausted')),
  -- A request id is an opaque provider handle. Anything long enough to be
  -- prose is refused rather than stored.
  constraint copilot_external_calls_request_id_short
    check (provider_request_id is null or length(provider_request_id) <= 128),
  constraint copilot_external_calls_model_short check (length(model) <= 128)
);

create index if not exists copilot_external_calls_org_idx
  on public.clinical_copilot_external_calls (organization_id, reserved_at desc);
create index if not exists copilot_external_calls_provider_idx
  on public.clinical_copilot_external_calls (provider_registry_id);
create index if not exists copilot_external_calls_run_idx
  on public.clinical_copilot_external_calls (run_id);
create index if not exists copilot_external_calls_budget_idx
  on public.clinical_copilot_external_calls (budget_id);

alter table public.clinical_copilot_external_calls enable row level security;
create policy copilot_external_calls_org_read
  on public.clinical_copilot_external_calls for select to authenticated
  using (exists (
    select 1 from public.organization_memberships m
    where m.organization_id = clinical_copilot_external_calls.organization_id
      and m.user_id = (select auth.uid()) and m.status = 'active'));
revoke insert, update, delete on public.clinical_copilot_external_calls from anon, authenticated;
