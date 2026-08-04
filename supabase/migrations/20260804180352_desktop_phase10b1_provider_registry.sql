-- Phase 10B.1 — Governed Copilot Provider Registry + Per-Org Activation
-- State Machine
--
-- Additive only. Two tables + one helper + the RPCs that transition their
-- state under the caller's RLS session. Nothing here activates a provider
-- for a real organization; each row starts at `disabled` and requires
-- every approval reference to be recorded before it can leave.
--
-- Secrets are NEVER stored in these tables. Neither `provider_secret_ref`
-- nor any related column may contain the secret value itself — only a
-- reference to where the secret lives in the approved secret manager (URI,
-- KMS key ARN, etc.). A CHECK constraint rejects strings that look like
-- OpenAI project keys or bearer tokens.
--
-- No commercial column is created here.

-- ---------------------------------------------------------------------------
-- Platform admin role (Phase 10B.1). Empty by default — no user can register
-- or revoke providers until a service_role migration inserts a row.
-- ---------------------------------------------------------------------------
create table if not exists public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  granted_by uuid references auth.users(id),
  granted_at timestamptz not null default now(),
  approval_reference text not null,
  constraint platform_admins_approval_nonempty check (length(trim(approval_reference)) > 0)
);
alter table public.platform_admins enable row level security;
create policy platform_admins_self_read on public.platform_admins for select to authenticated
  using (user_id = auth.uid());
revoke insert, update, delete on public.platform_admins from anon, authenticated;

create or replace function public.is_platform_admin(_uid uuid)
returns boolean language sql stable security definer set search_path to '' as $$
  select exists (select 1 from public.platform_admins where user_id = _uid);
$$;

-- ---------------------------------------------------------------------------
-- Provider registry
-- ---------------------------------------------------------------------------
create table if not exists public.clinical_copilot_provider_registry (
  id uuid primary key default gen_random_uuid(),
  provider_name text not null,
  provider_kind text not null,
  approved_model_allowlist jsonb not null default '[]'::jsonb,
  approval_reference text not null,
  baa_status_reference text,
  retention_mode text not null,
  processing_region text,
  key_ownership text not null,
  provider_secret_ref text,
  activation_date timestamptz,
  expiration_date timestamptz,
  last_validated_at timestamptz,
  revocation_state text not null default 'not_revoked',
  revocation_reason text,
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  constraint provider_registry_kind_check
    check (provider_kind in ('openai_hipaa','anthropic_hipaa','platform_governed','synthetic_fixture')),
  constraint provider_registry_retention_check
    check (retention_mode in ('zero','modified','standard','unspecified')),
  constraint provider_registry_key_ownership_check
    check (key_ownership in ('platform_governed','org_byok')),
  constraint provider_registry_revocation_state_check
    check (revocation_state in ('not_revoked','revoked')),
  constraint provider_registry_secret_ref_shape check (
    provider_secret_ref is null
    or (provider_secret_ref !~ '^(sk-|pk_|Bearer |eyJ)' and length(provider_secret_ref) <= 512)
  ),
  constraint provider_registry_approval_ref_nonempty
    check (length(trim(approval_reference)) > 0)
);
alter table public.clinical_copilot_provider_registry enable row level security;
create policy provider_registry_authenticated_read
  on public.clinical_copilot_provider_registry for select to authenticated using (true);
revoke insert, update, delete on public.clinical_copilot_provider_registry from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Per-organization activation state machine
-- ---------------------------------------------------------------------------
create table if not exists public.clinical_copilot_org_activations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider_registry_id uuid not null references public.clinical_copilot_provider_registry(id) on delete restrict,
  state text not null default 'disabled',
  legal_approval_reference text,
  privacy_approval_reference text,
  clinical_approval_reference text,
  infra_approval_reference text,
  retention_posture text not null default 'unspecified',
  activated_at timestamptz,
  activated_by uuid references auth.users(id),
  suspended_at timestamptz,
  suspended_by uuid references auth.users(id),
  suspension_reason text,
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id),
  revocation_reason text,
  supervised_runs_required int not null default 25,
  supervised_runs_completed int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  constraint org_activation_state_check check (
    state in ('disabled','readiness_review','approved_for_synthetic',
              'approved_for_phi','suspended','revoked')),
  constraint org_activation_retention_check check (
    retention_posture in ('unspecified','zero','modified','standard'))
);
alter table public.clinical_copilot_org_activations enable row level security;
create policy org_activations_tenant_read on public.clinical_copilot_org_activations for select to authenticated
  using (organization_id in (
    select om.organization_id from public.organization_memberships om
    where om.user_id = auth.uid() and om.status = 'active'
  ));
revoke insert, update, delete on public.clinical_copilot_org_activations from anon, authenticated;

-- Only one active row per (org, provider). btree_gist is not available so
-- a partial UNIQUE index enforces this instead of an EXCLUDE constraint.
create unique index if not exists org_activation_unique_active
  on public.clinical_copilot_org_activations (organization_id, provider_registry_id)
  where state in ('approved_for_synthetic','approved_for_phi');

create index if not exists org_activations_org_state_idx
  on public.clinical_copilot_org_activations (organization_id, state);
create index if not exists provider_registry_kind_idx
  on public.clinical_copilot_provider_registry (provider_kind, revocation_state);

comment on table public.clinical_copilot_provider_registry is
  'Phase 10B.1: registry of approved copilot providers. Never stores secret values; provider_secret_ref points at the approved secret manager.';
comment on table public.clinical_copilot_org_activations is
  'Phase 10B.1: per-organization activation state machine. State transitions require every approval reference to be recorded before approved_for_phi.';

